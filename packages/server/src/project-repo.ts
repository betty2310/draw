import { DurableObject } from "cloudflare:workers";
import {
  CLEANUP_EVERY_MS,
  decodeFrame,
  encodeFrame,
  isVersionOpen,
  MAIN_BRANCH,
  MAX_BRANCH_NAME,
  MAX_SCENE_BYTES,
  MAX_VERSION_NAME,
  PING,
  PONG,
  sha256Hex,
  UNNAMED_VERSION_TTL_MS,
  type BranchInfo,
  type ClientMessage,
  type CreateBranchRequest,
  type Head,
  type ServerMessage,
  type VersionInfo,
} from "@draw/shared";
import type { Env } from "./index.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL,
  scene BLOB NOT NULL,
  hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_branch_id ON versions (branch, id);
CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY,
  from_version_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  file_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL
);
`;

/** The versions that the delete of old versions keeps, whatever their age. */
const PROTECTED_VERSIONS = `
  SELECT MAX(id) FROM versions GROUP BY branch
  UNION SELECT from_version_id FROM branches WHERE from_version_id IS NOT NULL`;

/**
 * The state of one WebSocket. It is kept in the WebSocket attachment, which stays through
 * hibernation, so the edit lock is not lost when the object leaves memory.
 */
interface Attachment {
  client: string;
  author: string;
  branch: string;
  editor: boolean;
}

type VersionRow = {
  id: number;
  hash: string;
  name: string;
  author: string;
  created_at: number;
  updated_at: number;
  branched_from: number;
};

type VersionInfoRow = {
  id: number;
  branch: string;
  name: string;
  author: string;
  created_at: number;
  updated_at: number;
  branches: string | null;
};

type BranchRow = {
  name: string;
  from_version_id: number | null;
  from_branch: string | null;
  created_at: number;
  updated_at: number | null;
};

/** The Worker turns a failure into an HTTP error. */
export interface Failure {
  error: string;
  status: 400 | 404 | 409;
}

const VERSION_INFO_SELECT = `
  SELECT id, branch, name, author, created_at, updated_at,
    (SELECT json_group_array(name) FROM branches WHERE from_version_id = versions.id) AS branches
  FROM versions`;

const BRANCH_SELECT = `
  SELECT name, from_version_id, created_at,
    (SELECT branch FROM versions WHERE id = branches.from_version_id) AS from_branch,
    (SELECT MAX(updated_at) FROM versions WHERE branch = branches.name) AS updated_at
  FROM branches`;

const cleanBranchName = (name: unknown) =>
  typeof name === "string" ? name.trim().slice(0, MAX_BRANCH_NAME) : "";

/** One instance for each project. It holds the versions of the project and is the source of truth. */
export class ProjectRepo extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO branches (name, from_version_id, created_at) VALUES (?, NULL, ?)",
      MAIN_BRANCH,
      this.now(),
    );
    // Answers the keepalive of the browser without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The time of the version rules. The tests replace it to move the clock. */
  protected now(): number {
    return Date.now();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const params = new URL(request.url).searchParams;
    const branch = params.get("branch") ?? MAIN_BRANCH;
    const client = params.get("client") ?? crypto.randomUUID();
    const author = (params.get("author") ?? "").slice(0, 100);

    const { 0: browser, 1: server } = new WebSocketPair();
    if (!this.#branchExists(branch)) {
      // The branch was deleted or renamed while this browser was away. It opens `main`.
      server.accept();
      send(server, { type: "branches", deleted: branch });
      server.close(4004, "Unknown branch");
      return new Response(null, { status: 101, webSocket: browser });
    }

    // The first person who opens a branch edits it. A tab that connects again keeps its lock.
    const sockets = this.#sockets(branch);
    const editor = sockets.find((s) => s.attachment.editor);
    const isEditor = !editor || editor.attachment.client === client;
    if (editor && isEditor) {
      // The old socket of this tab is dead. It must not release the lock when it closes.
      editor.ws.serializeAttachment({ ...editor.attachment, editor: false });
      editor.ws.close(4000, "The same tab connected again");
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ client, author, branch, editor: isEditor } satisfies Attachment);

    const head = this.#head(branch);
    send(server, {
      type: "hello",
      role: isEditor ? "editor" : "viewer",
      editor: isEditor ? author : editor!.attachment.author,
      head,
      imageIds: this.ctx.storage.sql
        .exec<{ file_id: string }>("SELECT file_id FROM images")
        .toArray()
        .map((row) => row.file_id),
    });
    if (head && head.hash !== params.get("known")) this.#sendScene(server, head);
    if (isEditor) {
      for (const other of sockets) {
        if (other.ws !== editor?.ws)
          send(other.ws, { type: "role", role: "viewer", editor: author });
      }
    }
    return new Response(null, { status: 101, webSocket: browser });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (typeof message === "string") {
      const parsed = JSON.parse(message) as ClientMessage;
      if (parsed.type === "takeover") this.#takeOver(ws, attachment);
      if (parsed.type === "restore") await this.#restore(ws, parsed.versionId, parsed.baseHash);
      return;
    }
    const { header, body } = decodeFrame(message);
    if (header.type !== "save") return send(ws, { type: "error", message: "Unknown message" });
    if (body.byteLength > MAX_SCENE_BYTES) {
      return send(ws, { type: "error", message: "The drawing is too large to save" });
    }
    await this.#save(ws, header.baseHash, body);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Completes the close handshake that the browser started.
    ws.close();
    const attachment = ws.deserializeAttachment() as Attachment;
    if (!attachment.editor) return;
    for (const other of this.#sockets(attachment.branch)) {
      if (other.ws !== ws) send(other.ws, { type: "role", role: "viewer", editor: null });
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  /** Deletes the old versions with no name. It runs at most one time each day. */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const deleted = sql.exec(
      `DELETE FROM versions WHERE name = '' AND updated_at < ? AND id NOT IN (${PROTECTED_VERSIONS})`,
      this.now() - UNNAMED_VERSION_TTL_MS,
    ).rowsWritten;
    if (deleted > 0) this.#notify(null, { type: "history" });
    // A project with no version that can expire does not wake each day.
    const canExpire =
      sql
        .exec(
          `SELECT 1 FROM versions WHERE name = '' AND id NOT IN (${PROTECTED_VERSIONS}) LIMIT 1`,
        )
        .toArray().length > 0;
    if (canExpire) await this.ctx.storage.setAlarm(this.now() + CLEANUP_EVERY_MS);
  }

  /** The Worker checks the size limit before the call. */
  async putImage(fileId: string, mime: string, bytes: ArrayBuffer): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO images (file_id, mime, bytes) VALUES (?, ?, ?)",
      fileId,
      mime,
      bytes,
    );
  }

  async getImage(fileId: string): Promise<{ mime: string; bytes: ArrayBuffer } | null> {
    const row = this.ctx.storage.sql
      .exec<{ mime: string; bytes: ArrayBuffer }>(
        "SELECT mime, bytes FROM images WHERE file_id = ?",
        fileId,
      )
      .toArray()[0];
    return row ?? null;
  }

  /** The versions of one branch, or of all branches when `branch` is null, newest first. */
  async listVersions(
    branch: string | null,
    namedOnly: boolean,
    limit: number,
  ): Promise<VersionInfo[]> {
    const where = [branch === null ? "1" : "branch = ?", namedOnly ? "name != ''" : "1"];
    return this.ctx.storage.sql
      .exec<VersionInfoRow>(
        `${VERSION_INFO_SELECT} WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
        ...(branch === null ? [] : [branch]),
        Math.min(Math.max(Math.trunc(limit) || 1, 1), 500),
      )
      .toArray()
      .map(toVersionInfo);
  }

  /** The gzip scene of a version, for the preview. */
  async getVersionScene(versionId: number): Promise<ArrayBuffer | null> {
    const row = this.ctx.storage.sql
      .exec<{ scene: ArrayBuffer }>("SELECT scene FROM versions WHERE id = ?", versionId)
      .toArray()[0];
    return row?.scene ?? null;
  }

  /** Gives a name to a version, or removes it with an empty name. A name closes the version. */
  async nameVersion(versionId: number, name: string): Promise<VersionInfo | Failure> {
    const updated = this.ctx.storage.sql
      .exec<{ branch: string }>(
        "UPDATE versions SET name = ? WHERE id = ? RETURNING branch",
        name.trim().slice(0, MAX_VERSION_NAME),
        versionId,
      )
      .toArray()[0];
    if (!updated) return { error: "The version does not exist", status: 404 };
    // The History panel shows the versions of all branches.
    this.#notify(null, { type: "history" });
    return toVersionInfo(
      this.ctx.storage.sql
        .exec<VersionInfoRow>(`${VERSION_INFO_SELECT} WHERE id = ?`, versionId)
        .one(),
    );
  }

  async listBranches(): Promise<BranchInfo[]> {
    return this.ctx.storage.sql
      .exec<BranchRow>(`${BRANCH_SELECT} ORDER BY name != ?, created_at`, MAIN_BRANCH)
      .toArray()
      .map(toBranchInfo);
  }

  /** Adds a branch with a first version that has a copy of the scene of `fromVersionId`. */
  async createBranch(request: CreateBranchRequest): Promise<BranchInfo | Failure> {
    const name = cleanBranchName(request.name);
    if (!name) return { error: "The branch needs a name", status: 400 };
    if (this.#branchExists(name)) return { error: `The branch "${name}" exists`, status: 409 };
    const sql = this.ctx.storage.sql;
    const source = sql
      .exec<{ branch: string; scene: ArrayBuffer; hash: string }>(
        "SELECT branch, scene, hash FROM versions WHERE id = ?",
        request.fromVersionId,
      )
      .toArray()[0];
    if (!source) return { error: "The version does not exist", status: 404 };

    const now = this.now();
    sql.exec(
      "INSERT INTO branches (name, from_version_id, created_at) VALUES (?, ?, ?)",
      name,
      request.fromVersionId,
      now,
    );
    sql.exec(
      "INSERT INTO versions (branch, scene, hash, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      name,
      source.scene,
      source.hash,
      String(request.author ?? "").slice(0, 100),
      now,
      now,
    );
    // The source version is now closed, and its row shows the new branch.
    this.#notify(source.branch, { type: "history" });
    this.#notify(null, { type: "branches" });
    await this.#scheduleCleanup();
    return toBranchInfo(sql.exec<BranchRow>(`${BRANCH_SELECT} WHERE name = ?`, name).one());
  }

  async renameBranch(from: string, newName: string): Promise<BranchInfo | Failure> {
    const to = cleanBranchName(newName);
    if (from === MAIN_BRANCH) return { error: "The main branch cannot be renamed", status: 400 };
    if (!this.#branchExists(from)) return { error: "The branch does not exist", status: 404 };
    if (!to) return { error: "The branch needs a name", status: 400 };
    if (to !== from && this.#branchExists(to)) {
      return { error: `The branch "${to}" exists`, status: 409 };
    }
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE branches SET name = ? WHERE name = ?", to, from);
    sql.exec("UPDATE versions SET branch = ? WHERE branch = ?", to, from);
    // The open sockets of the branch continue on the new name.
    for (const { ws, attachment } of this.#sockets(from)) {
      ws.serializeAttachment({ ...attachment, branch: to });
    }
    this.#notify(null, { type: "branches", renamed: { from, to } });
    return toBranchInfo(sql.exec<BranchRow>(`${BRANCH_SELECT} WHERE name = ?`, to).one());
  }

  /** Deletes a branch and its versions. Other branches keep their own copies. */
  async deleteBranch(name: string): Promise<Failure | null> {
    if (name === MAIN_BRANCH) return { error: "The main branch cannot be deleted", status: 400 };
    if (!this.#branchExists(name)) return { error: "The branch does not exist", status: 404 };
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM versions WHERE branch = ?", name);
    sql.exec("DELETE FROM branches WHERE name = ?", name);
    const sockets = this.#sockets(name);
    this.#notify(null, { type: "branches", deleted: name });
    for (const { ws } of sockets) ws.close(4004, "The branch was deleted");
    return null;
  }

  async #save(ws: WebSocket, baseHash: string | null, body: Uint8Array) {
    const scene = body.slice();
    // Hash first: the checks and the write below have no await between them.
    const hash = await sha256Hex(scene);
    const { branch, author, editor } = ws.deserializeAttachment() as Attachment;
    if (!editor) {
      return send(ws, { type: "error", message: "This browser does not edit the branch" });
    }
    if (!this.#branchExists(branch)) return send(ws, { type: "branches", deleted: branch });
    const sql = this.ctx.storage.sql;
    const newest = this.#newestVersion(branch);
    // A save with an old hash would silently replace the work of a different browser.
    if (newest && newest.hash !== baseHash) return this.#refuse(ws, newest);
    if (newest?.hash === hash) return send(ws, { type: "saved", head: toHead(newest) });

    const now = this.now();
    const open =
      newest &&
      isVersionOpen(
        {
          createdAt: newest.created_at,
          author: newest.author,
          name: newest.name,
          branchedFrom: newest.branched_from === 1,
        },
        { now, author },
      );
    const versionId = open
      ? sql
          .exec<{ id: number }>(
            "UPDATE versions SET scene = ?, hash = ?, updated_at = ? WHERE id = ? RETURNING id",
            scene,
            hash,
            now,
            newest.id,
          )
          .one().id
      : this.#addVersion(branch, scene, hash, author, now);
    const head: Head = { versionId, hash, author, updatedAt: now };
    send(ws, { type: "saved", head });
    // Read-only viewers of the branch show each save.
    const frame = encodeFrame({ type: "scene", head }, scene);
    for (const other of this.#sockets(branch)) {
      if (other.ws !== ws) other.ws.send(frame);
    }
    if (open) return;
    this.#notifyOtherBranches(branch);
    await this.#scheduleCleanup();
  }

  /** Adds a new version with a copy of an old version of the same branch. No version is removed. */
  async #restore(ws: WebSocket, versionId: number, baseHash: string | null) {
    const { branch, author, editor } = ws.deserializeAttachment() as Attachment;
    if (!editor) {
      return send(ws, { type: "error", message: "Take over the branch to restore a version" });
    }
    const newest = this.#newestVersion(branch);
    if (newest && newest.hash !== baseHash) return this.#refuse(ws, newest);
    const source = this.ctx.storage.sql
      .exec<{ scene: ArrayBuffer; hash: string }>(
        "SELECT scene, hash FROM versions WHERE id = ? AND branch = ?",
        versionId,
        branch,
      )
      .toArray()[0];
    if (!source) {
      return send(ws, { type: "error", message: "The version is not in this branch" });
    }
    const now = this.now();
    const id = this.#addVersion(branch, source.scene, source.hash, author, now);
    const head: Head = { versionId: id, hash: source.hash, author, updatedAt: now };
    const frame = encodeFrame(
      { type: "scene", head, restored: true },
      new Uint8Array(source.scene),
    );
    for (const other of this.#sockets(branch)) other.ws.send(frame);
    this.#notifyOtherBranches(branch);
    await this.#scheduleCleanup();
  }

  #addVersion(
    branch: string,
    scene: ArrayBuffer | Uint8Array,
    hash: string,
    author: string,
    now: number,
  ) {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO versions (branch, scene, hash, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        branch,
        scene,
        hash,
        author,
        now,
        now,
      )
      .one().id;
  }

  /** Refuses a change that was made on an old scene, and sends the current scene. */
  #refuse(ws: WebSocket, newest: VersionRow) {
    const head = toHead(newest);
    send(ws, { type: "conflict", head });
    this.#sendScene(ws, head);
  }

  /** Each new version can expire, so the delete of old versions must have a time. */
  async #scheduleCleanup() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(this.now() + CLEANUP_EVERY_MS);
    }
  }

  #takeOver(ws: WebSocket, attachment: Attachment) {
    for (const other of this.#sockets(attachment.branch)) {
      const editor = other.ws === ws;
      if (other.attachment.editor !== editor) {
        other.ws.serializeAttachment({ ...other.attachment, editor });
      }
      send(other.ws, {
        type: "role",
        role: editor ? "editor" : "viewer",
        editor: attachment.author,
      });
    }
  }

  /** The sockets of one branch, or of all branches. */
  #sockets(branch: string | null) {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, attachment: ws.deserializeAttachment() as Attachment }))
      .filter(({ attachment }) => branch === null || attachment.branch === branch);
  }

  #notify(branch: string | null, message: ServerMessage) {
    for (const { ws } of this.#sockets(branch)) send(ws, message);
  }

  /** The History panel shows all branches, so a new version on one branch changes it for all. */
  #notifyOtherBranches(branch: string) {
    for (const other of this.#sockets(null)) {
      if (other.attachment.branch !== branch) send(other.ws, { type: "history" });
    }
  }

  #branchExists(branch: string) {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM branches WHERE name = ?", branch).toArray().length >
      0
    );
  }

  #newestVersion(branch: string): VersionRow | undefined {
    return this.ctx.storage.sql
      .exec<VersionRow>(
        `SELECT id, hash, name, author, created_at, updated_at,
           EXISTS (SELECT 1 FROM branches WHERE from_version_id = versions.id) AS branched_from
         FROM versions WHERE branch = ? ORDER BY id DESC LIMIT 1`,
        branch,
      )
      .toArray()[0];
  }

  #head(branch: string): Head | null {
    const newest = this.#newestVersion(branch);
    return newest ? toHead(newest) : null;
  }

  #sendScene(ws: WebSocket, head: Head) {
    const { scene } = this.ctx.storage.sql
      .exec<{ scene: ArrayBuffer }>("SELECT scene FROM versions WHERE id = ?", head.versionId)
      .one();
    ws.send(encodeFrame({ type: "scene", head }, new Uint8Array(scene)));
  }
}

function toHead(row: VersionRow): Head {
  return { versionId: row.id, hash: row.hash, author: row.author, updatedAt: row.updated_at };
}

function toVersionInfo(row: VersionInfoRow): VersionInfo {
  return {
    id: row.id,
    branch: row.branch,
    name: row.name,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    branches: row.branches ? (JSON.parse(row.branches) as string[]) : [],
  };
}

function toBranchInfo(row: BranchRow): BranchInfo {
  return {
    name: row.name,
    fromVersionId: row.from_version_id,
    fromBranch: row.from_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}
