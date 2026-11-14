import { DurableObject } from "cloudflare:workers";
import { sha256Hex, type ServerMessage } from "@draw/shared";
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
`;

/** One instance for each project. It holds the versions of the project and is the source of truth. */
export class ProjectRepo extends DurableObject<Env> {
  #colo: Promise<string> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // The Hibernation API keeps the socket open while the object is out of memory.
    this.ctx.acceptWebSocket(server);
    void this.#sendHello(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") {
      send(ws, { type: "error", message: "A save must be a binary message" });
      return;
    }
    // Phase 0 adds one version for each save. Phase 1 writes into the open version
    // of the branch (see VERSION_OPEN_MS in @draw/shared).
    const hash = await sha256Hex(message);
    const now = Date.now();
    const { id } = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO versions (branch, scene, hash, created_at, updated_at) VALUES ('main', ?, ?, ?, ?) RETURNING id",
        message,
        hash,
        now,
        now,
      )
      .one();
    send(ws, { type: "saved", versionId: id, size: message.byteLength, hash });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Completes the close handshake that the browser started.
    ws.close();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  /** Tells the browser which data center runs this object, so measurements can be read correctly. */
  async #sendHello(ws: WebSocket): Promise<void> {
    this.#colo ??= fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.text())
      .then((text) => /^colo=(\w+)$/m.exec(text)?.[1] ?? "unknown")
      .catch(() => "unknown");
    send(ws, { type: "hello", colo: await this.#colo });
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}
