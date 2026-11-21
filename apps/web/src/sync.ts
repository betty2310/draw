import { createStore, del, get, set } from "idb-keyval";
import {
  CLOSE_NO_PROJECT,
  CLOSE_NO_SESSION,
  decodeFrame,
  encodeFrame,
  gunzip,
  gzip,
  PING,
  PONG,
  projectImagePath,
  projectSocketPath,
  type Head,
  type Role,
  type ServerMessage,
} from "@draw/shared";
import { signalSignedOut } from "./api.ts";

/** Autosave sends the scene to the server this time after the last change. */
const SERVER_SAVE_DELAY_MS = 2000;
const PING_EVERY_MS = 15_000;
const PONG_TIMEOUT_MS = 5000;

/** The copy of one branch in this browser. It holds each change before the server has it. */
interface LocalCopy {
  /** The scene as `.excalidraw` JSON. */
  json: string;
  /** Hash of the server version that this copy started from, or null for a new project. */
  baseHash: string | null;
  /** true when the copy has changes that the server does not have. */
  dirty: boolean;
}

export interface ImageFile {
  id: string;
  mimeType: string;
  dataURL: string;
}

export type SaveStatus = "saved" | "saving" | "offline";

export interface SyncState {
  /** The branch that this page shows. It changes when somebody renames it. */
  branch: string;
  /** Null until the server tells the role. */
  role: Role | null;
  /** The name of the person who edits the branch. */
  editor: string | null;
  status: SaveStatus;
  /** Hash of the newest server version that this browser has. */
  head: string | null;
  /** Id of that version. */
  headVersionId: number | null;
  error: string | null;
}

export interface SyncHost {
  /** The current scene as `.excalidraw` JSON. */
  serialize(): string;
  /** The images of the current scene. */
  files(): ImageFile[];
  /** Shows a scene from the server. With `merge`, the local changes are kept. */
  applyRemote(json: string, merge: boolean): void;
  onState(state: SyncState): void;
  onSaved(): void;
  /** The version list or the branch list can be different now. */
  onHistory(): void;
  /** The branch was deleted. The page opens `main`. */
  onBranchGone(): void;
}

const store = createStore("draw", "local");
const localKey = (projectId: string, branch: string) => `scene:${projectId}:${branch}`;
const fileKey = (projectId: string, fileId: string) => `file:${projectId}:${fileId}`;

export function loadLocalImage(projectId: string, fileId: string) {
  return get<ImageFile>(fileKey(projectId, fileId), store);
}

/**
 * Autosave and the WebSocket of one project. Each change goes to IndexedDB immediately and to
 * the server 2 seconds after the last change. A save carries the hash that the browser last saw,
 * so the server refuses a save that would replace the work of a different browser.
 */
export class ProjectSync {
  readonly #projectId: string;
  #branch: string;
  readonly #host: SyncHost;
  /** Random id of this page. A connection again from the same page keeps its edit lock. */
  readonly #client = crypto.randomUUID();

  #state: SyncState;
  #baseHash: string | null = null;
  #dirty = false;
  /** Counts local changes, so a save reply tells if a change came during the save. */
  #changes = 0;
  #savedChanges = 0;

  #socket: WebSocket | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saving = false;
  /** The save timer fired during a save. */
  #saveAgain = false;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectDelay = 500;
  #closed = false;

  #writing: Promise<void> | null = null;
  #writeAgain = false;
  #serverImages = new Set<string>();
  #localImages = new Set<string>();
  /** Called when the server has each local change. */
  #flushWaiters: Array<() => void> = [];
  /** A restore that waits for the save of the local changes. */
  #pendingRestore: number | null = null;

  constructor(projectId: string, branch: string, host: SyncHost) {
    this.#projectId = projectId;
    this.#branch = branch;
    this.#host = host;
    this.#state = {
      branch,
      role: null,
      editor: null,
      status: "offline",
      head: null,
      headVersionId: null,
      error: null,
    };
  }

  /** Loads the copy of this browser, which the editor shows before the server answers. */
  async load(): Promise<string | null> {
    const local = await get<LocalCopy>(localKey(this.#projectId, this.#branch), store);
    if (!local) return null;
    this.#baseHash = local.baseHash;
    this.#dirty = local.dirty;
    return local.json;
  }

  /** Call after `load`, when the editor shows the local copy. */
  connect() {
    addEventListener("online", this.#onOnline);
    addEventListener("offline", this.#onOffline);
    addEventListener("pagehide", this.#flushLocal);
    document.addEventListener("visibilitychange", this.#flushLocal);
    this.#connect();
  }

  stop() {
    this.#closed = true;
    removeEventListener("online", this.#onOnline);
    removeEventListener("offline", this.#onOffline);
    removeEventListener("pagehide", this.#flushLocal);
    document.removeEventListener("visibilitychange", this.#flushLocal);
    clearTimeout(this.#saveTimer);
    clearTimeout(this.#reconnectTimer);
    this.#stopPing();
    // Each change is already in IndexedDB, so nothing is written here.
    this.#socket?.close();
  }

  /** The editor calls this after each change of the scene. */
  changed() {
    if (this.#state.role !== "editor") return;
    this.#changes++;
    this.#dirty = true;
    void this.#writeLocal();
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.#saveToServer(), SERVER_SAVE_DELAY_MS);
    this.#update({});
  }

  takeOver() {
    this.#socket?.send(JSON.stringify({ type: "takeover" }));
  }

  /** Resolves when the server has each local change, so a name or a branch includes them. */
  flush(): Promise<void> {
    if (!this.#dirty || this.#state.role !== "editor") return Promise.resolve();
    clearTimeout(this.#saveTimer);
    void this.#saveToServer();
    return new Promise((resolve) => this.#flushWaiters.push(resolve));
  }

  /**
   * Adds a new version with a copy of the scene of `versionId`. The local changes are saved
   * first, so they stay in the history.
   */
  restore(versionId: number) {
    if (this.#state.role !== "editor") return;
    this.#pendingRestore = versionId;
    if (this.#dirty) return void this.flush();
    this.#sendRestore();
  }

  #sendRestore() {
    const versionId = this.#pendingRestore;
    if (versionId === null || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#pendingRestore = null;
    this.#socket.send(JSON.stringify({ type: "restore", versionId, baseHash: this.#baseHash }));
  }

  get state() {
    return this.#state;
  }

  #update(patch: Partial<SyncState>) {
    const next = { ...this.#state, ...patch };
    const connected = this.#socket?.readyState === WebSocket.OPEN && next.role !== null;
    const status: SaveStatus = !connected ? "offline" : this.#dirty ? "saving" : "saved";
    this.#state = { ...next, status };
    this.#host.onState(this.#state);
  }

  /** Writes the newest scene to IndexedDB. Changes during a write are written after it. */
  #writeLocal = (): Promise<void> => {
    if (this.#writing) {
      this.#writeAgain = true;
      return this.#writing;
    }
    this.#writing = (async () => {
      do {
        this.#writeAgain = false;
        await this.#storeImages();
        const copy: LocalCopy = {
          json: this.#host.serialize(),
          baseHash: this.#baseHash,
          dirty: this.#dirty,
        };
        await set(localKey(this.#projectId, this.#branch), copy, store);
      } while (this.#writeAgain);
    })().finally(() => (this.#writing = null));
    return this.#writing;
  };

  #flushLocal = () => {
    if (this.#dirty) void this.#writeLocal();
  };

  /** Keeps pasted images in this browser, so the editor opens offline with them. */
  async #storeImages() {
    for (const file of this.#host.files()) {
      if (this.#localImages.has(file.id)) continue;
      const key = fileKey(this.#projectId, file.id);
      if (!(await get(key, store))) {
        await set(key, { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL }, store);
      }
      this.#localImages.add(file.id);
    }
  }

  async #saveToServer() {
    const socket = this.#socket;
    if (!this.#dirty || this.#state.role !== "editor") return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (this.#saving) {
      this.#saveAgain = true;
      return;
    }
    this.#saving = true;
    try {
      // The server must have each image before a scene that uses it.
      await this.#uploadImages();
      const changes = this.#changes;
      const bytes = await gzip(this.#host.serialize());
      this.#savedChanges = changes;
      socket.send(encodeFrame({ type: "save", baseHash: this.#baseHash }, bytes));
    } catch (error) {
      this.#saving = false;
      this.#update({ error: String(error instanceof Error ? error.message : error) });
      this.#saveTimer = setTimeout(() => void this.#saveToServer(), SERVER_SAVE_DELAY_MS);
    }
  }

  async #uploadImages() {
    for (const file of this.#host.files()) {
      if (this.#serverImages.has(file.id)) continue;
      const blob = await (await fetch(file.dataURL)).blob();
      const response = await fetch(projectImagePath(this.#projectId, file.id), {
        method: "PUT",
        headers: { "Content-Type": file.mimeType },
        body: blob,
      });
      if (response.status === 413) throw new Error("An image is too large. The limit is 1.5 MB.");
      if (!response.ok) throw new Error(`The image upload failed (${response.status})`);
      this.#serverImages.add(file.id);
    }
  }

  #connect() {
    if (this.#closed) return;
    const url = new URL(
      projectSocketPath(this.#projectId, {
        branch: this.#branch,
        client: this.#client,
        known: this.#baseHash ?? "",
      }),
      location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#reconnectDelay = 500;
      this.#startPing(socket);
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      clearTimeout(this.#pongTimer);
      if (event.data === PONG) return;
      if (typeof event.data === "string") {
        this.#onMessage(JSON.parse(event.data) as ServerMessage);
      } else {
        void this.#onScene(event.data as ArrayBuffer);
      }
    });
    socket.addEventListener("close", (event) => {
      if (socket !== this.#socket) return;
      // The Worker refused the socket. A new connection gets the same answer, so stop.
      if (event.code === CLOSE_NO_SESSION || event.code === CLOSE_NO_PROJECT) {
        this.stop();
        this.#update({
          error:
            event.code === CLOSE_NO_PROJECT
              ? "This project does not exist, or it is in the workspace of a different person."
              : null,
        });
        if (event.code === CLOSE_NO_SESSION) signalSignedOut();
        return;
      }
      this.#drop();
    });
  }

  /** Forgets the socket at once and connects again later. A dead socket can take long to close. */
  #drop() {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#stopPing();
    this.#saving = false;
    this.#update({});
    this.#scheduleReconnect();
  }

  #onMessage(message: ServerMessage) {
    switch (message.type) {
      case "hello": {
        this.#serverImages = new Set(message.imageIds);
        const head = message.head?.hash ?? null;
        this.#update({
          role: message.role,
          editor: message.editor,
          head,
          headVersionId: message.head?.versionId ?? null,
          error: null,
        });
        // A scene frame follows when the server has a different scene.
        if (head === this.#baseHash && this.#dirty) void this.#saveToServer();
        break;
      }
      case "role": {
        const wasEditor = this.#state.role === "editor";
        this.#update({ role: message.role, editor: message.editor });
        if (!wasEditor && message.role === "editor" && this.#dirty)
          void this.#restoreLocalChanges();
        break;
      }
      case "saved":
        this.#onSaved(message.head);
        break;
      case "conflict":
        // The scene frame that follows is merged with the local changes.
        this.#saving = false;
        break;
      case "error":
        this.#saving = false;
        this.#update({ error: message.message });
        break;
      case "history":
        this.#host.onHistory();
        break;
      case "branches":
        if (message.deleted === this.#branch) void this.#branchGone();
        else if (message.renamed?.from === this.#branch)
          void this.#branchRenamed(message.renamed.to);
        this.#host.onHistory();
        break;
    }
  }

  /** The server moved this socket to the new name. The local copy moves too. */
  async #branchRenamed(to: string) {
    const from = this.#branch;
    this.#branch = to;
    this.#update({ branch: to });
    await this.#writing;
    const local = await get<LocalCopy>(localKey(this.#projectId, from), store);
    if (local) await set(localKey(this.#projectId, to), local, store);
    await del(localKey(this.#projectId, from), store);
  }

  async #branchGone() {
    this.stop();
    await this.#writing;
    await del(localKey(this.#projectId, this.#branch), store);
    this.#host.onBranchGone();
  }

  #onSaved(head: Head) {
    this.#saving = false;
    this.#baseHash = head.hash;
    if (this.#changes === this.#savedChanges) this.#dirty = false;
    this.#update({ head: head.hash, headVersionId: head.versionId, error: null });
    void this.#writeLocal();
    this.#host.onSaved();
    this.#host.onHistory();
    if (this.#saveAgain || (this.#dirty && this.#flushWaiters.length > 0)) {
      this.#saveAgain = false;
      void this.#saveToServer();
    } else if (!this.#dirty) {
      for (const resolve of this.#flushWaiters.splice(0)) resolve();
      this.#sendRestore();
    }
  }

  /**
   * A viewer shows the server scene and keeps its own unsaved changes in IndexedDB.
   * When it edits again, it merges them into the scene.
   */
  async #restoreLocalChanges() {
    const local = await get<LocalCopy>(localKey(this.#projectId, this.#branch), store);
    if (local?.dirty) this.#host.applyRemote(local.json, true);
    this.changed();
  }

  async #onScene(frame: ArrayBuffer) {
    const { header, body } = decodeFrame(frame);
    if (header.type !== "scene") return;
    const json = await gunzip(body.slice());
    this.#baseHash = header.head.hash;
    this.#update({ head: header.head.hash, headVersionId: header.head.versionId });
    this.#host.onHistory();
    if (header.restored && this.#state.role === "editor") {
      // The editor asked for the restore after its changes were saved. The old scene replaces them.
      this.#dirty = false;
      this.#changes = this.#savedChanges;
      this.#update({});
    }
    if (this.#state.role === "editor" && this.#dirty) {
      // The server has a scene that this browser did not see. Keep both.
      this.#host.applyRemote(json, true);
      this.changed();
      return;
    } else {
      this.#host.applyRemote(json, false);
    }
    // A viewer keeps the changes that it made as editor, until it edits again.
    if (!this.#dirty) void this.#writeLocal();
  }

  #startPing(socket: WebSocket) {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      socket.send(PING);
      clearTimeout(this.#pongTimer);
      // A connection that does not answer is dead, for example after a network change.
      this.#pongTimer = setTimeout(() => socket === this.#socket && this.#drop(), PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  #stopPing() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    if (this.#closed) return;
    this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelay);
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 10_000);
  }

  #onOnline = () => {
    this.#reconnectDelay = 500;
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = null;
    this.#connect();
  };

  #onOffline = () => {
    if (this.#socket) this.#drop();
  };
}
