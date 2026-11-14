/** Phase 1 has one branch. Phase 2 adds more. */
export const MAIN_BRANCH = "main";

/** Size limits that keep each SQLite row below the 2 MB row limit of a Durable Object. */
export const MAX_SCENE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/** Text that the browser sends to detect a dead connection. The server replies with `PONG`. */
export const PING = "ping";
export const PONG = "pong";

export interface SocketParams {
  branch: string;
  /** The name that the person typed at the first visit. */
  author: string;
  /** Random id of one browser tab. A tab that connects again keeps its edit lock. */
  client: string;
  /** Hash of the scene that the browser has. The server sends the scene only if it is different. */
  known: string;
}

/** Path of the WebSocket of one project. */
export function projectSocketPath(projectId: string, params?: SocketParams): string {
  const path = `/api/projects/${encodeURIComponent(projectId)}/ws`;
  return params ? `${path}?${new URLSearchParams({ ...params })}` : path;
}

export function projectImagePath(projectId: string, fileId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(fileId)}`;
}

/** The newest version of a branch. */
export interface Head {
  versionId: number;
  /** SHA-256 of the gzip scene bytes. */
  hash: string;
  author: string;
  updatedAt: number;
}

export type Role = "editor" | "viewer";

/** JSON messages from the project Durable Object to the browser. */
export type ServerMessage =
  | {
      type: "hello";
      role: Role;
      /** Name of the person who edits the branch, or null if nobody edits it. */
      editor: string | null;
      head: Head | null;
      /** The images that the server has. */
      imageIds: string[];
    }
  | { type: "role"; role: Role; editor: string | null }
  | { type: "saved"; head: Head }
  /** The save had an old hash. A scene frame with the current head follows. */
  | { type: "conflict"; head: Head }
  | { type: "error"; message: string };

/** JSON messages from the browser that are not saves. */
export type ClientMessage = { type: "takeover" };

/**
 * Binary messages carry a scene: a 4-byte length, a JSON header, and the gzip scene bytes.
 * The browser sends `save` frames. The server sends `scene` frames.
 */
export type FrameHeader = { type: "save"; baseHash: string | null } | { type: "scene"; head: Head };

export function encodeFrame(header: FrameHeader, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + json.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, json.byteLength);
  frame.set(json, 4);
  frame.set(body, 4 + json.byteLength);
  return frame;
}

export function decodeFrame(frame: ArrayBuffer): { header: FrameHeader; body: Uint8Array } {
  const length = new DataView(frame).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length)));
  return { header, body: new Uint8Array(frame, 4 + length) };
}

/** A row of the project list. */
export interface Project {
  id: string;
  name: string;
  /** A small image of the drawing as a data URL, or empty. */
  thumb: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ProjectPatch {
  name?: string;
  /** true moves the project to the trash, false restores it. */
  trashed?: boolean;
  thumb?: string;
}

export interface HealthResponse {
  ok: boolean;
  /** Cloudflare data center that received the request. */
  colo: string;
}
