import { DurableObject } from "cloudflare:workers";
import {
  decodeFrame,
  encodeFrame,
  isVersionOpen,
  MAIN_BRANCH,
  MAX_SCENE_BYTES,
  PING,
  PONG,
  sha256Hex,
  type ClientMessage,
  type Head,
  type ServerMessage,
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

/** One instance for each project. It holds the versions of the project and is the source of truth. */
export class ProjectRepo extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO branches (name, from_version_id, created_at) VALUES (?, NULL, ?)",
      MAIN_BRANCH,
      Date.now(),
    );
    // Answers the keepalive of the browser without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const params = new URL(request.url).searchParams;
    const branch = params.get("branch") ?? MAIN_BRANCH;
    const client = params.get("client") ?? crypto.randomUUID();
    const author = (params.get("author") ?? "").slice(0, 100);
    if (!this.#branchExists(branch)) return new Response("Unknown branch", { status: 404 });

    // The first person who opens a branch edits it. A tab that connects again keeps its lock.
    const sockets = this.#sockets(branch);
    const editor = sockets.find((s) => s.attachment.editor);
    const isEditor = !editor || editor.attachment.client === client;
    if (editor && isEditor) {
      // The old socket of this tab is dead. It must not release the lock when it closes.
      editor.ws.serializeAttachment({ ...editor.attachment, editor: false });
      editor.ws.close(4000, "The same tab connected again");
    }

    const { 0: browser, 1: server } = new WebSocketPair();
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
    if (head && head.hash !== params.get("known")) this.#sendScene(server, branch, head);
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

  async #save(ws: WebSocket, baseHash: string | null, body: Uint8Array) {
    const scene = body.slice();
    // Hash first: the checks and the write below have no await between them.
    const hash = await sha256Hex(scene);
    const { branch, author, editor } = ws.deserializeAttachment() as Attachment;
    if (!editor) {
      return send(ws, { type: "error", message: "This browser does not edit the branch" });
    }
    const sql = this.ctx.storage.sql;
    const newest = this.#newestVersion(branch);
    // A save with an old hash would silently replace the work of a different browser.
    if (newest && newest.hash !== baseHash) {
      const head = toHead(newest);
      send(ws, { type: "conflict", head });
      this.#sendScene(ws, branch, head);
      return;
    }
    if (newest?.hash === hash) return send(ws, { type: "saved", head: toHead(newest) });

    const now = Date.now();
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
      : sql
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
    const head: Head = { versionId, hash, author, updatedAt: now };
    send(ws, { type: "saved", head });
    // Read-only viewers of the branch show each save.
    const frame = encodeFrame({ type: "scene", head }, scene);
    for (const other of this.#sockets(branch)) {
      if (other.ws !== ws) other.ws.send(frame);
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

  #sockets(branch: string) {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, attachment: ws.deserializeAttachment() as Attachment }))
      .filter(({ attachment }) => attachment.branch === branch);
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

  #sendScene(ws: WebSocket, branch: string, head: Head) {
    const { scene } = this.ctx.storage.sql
      .exec<{ scene: ArrayBuffer }>(
        "SELECT scene FROM versions WHERE branch = ? AND id = ?",
        branch,
        head.versionId,
      )
      .one();
    ws.send(encodeFrame({ type: "scene", head }, new Uint8Array(scene)));
  }
}

function toHead(row: VersionRow): Head {
  return { versionId: row.id, hash: row.hash, author: row.author, updatedAt: row.updated_at };
}

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}
