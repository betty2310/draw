/** Each project has this branch. It cannot be renamed or deleted. */
export const MAIN_BRANCH = "main";

export const MAX_BRANCH_NAME = 60;
export const MAX_VERSION_NAME = 200;

/** Size limits that keep each SQLite row below the 2 MB row limit of a Durable Object. */
export const MAX_SCENE_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * Close codes of a project WebSocket that the Worker refuses. The browser cannot read the HTTP
 * status of a refused upgrade, so the Worker accepts the socket and closes it with this code.
 */
export const CLOSE_NO_SESSION = 4401;
export const CLOSE_NO_PROJECT = 4404;

/** Text that the browser sends to detect a dead connection. The server replies with `PONG`. */
export const PING = "ping";
export const PONG = "pong";

export interface SocketParams {
  branch: string;
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

/** Path of the branch list, or of one branch. */
export function branchPath(projectId: string, branch?: string): string {
  const path = `/api/projects/${encodeURIComponent(projectId)}/branches`;
  return branch === undefined ? path : `${path}/${encodeURIComponent(branch)}`;
}

/** Path of the version list, or of one version. */
export function versionPath(projectId: string, versionId?: number): string {
  const path = `/api/projects/${encodeURIComponent(projectId)}/versions`;
  return versionId === undefined ? path : `${path}/${versionId}`;
}

/** A row of the history panel. */
export interface VersionInfo {
  id: number;
  branch: string;
  /** Empty for a version with no name. */
  name: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  /** The branches that were created from this version. */
  branches: string[];
}

export interface BranchInfo {
  name: string;
  /** The version that the branch was created from. Null for `main`. */
  fromVersionId: number | null;
  /** The branch of that version, or null when it was deleted. */
  fromBranch: string | null;
  createdAt: number;
  /** The time of the last save, or null when the branch has no version. */
  updatedAt: number | null;
}

export interface CreateBranchRequest {
  name: string;
  fromVersionId: number;
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
  | { type: "error"; message: string }
  /** The version list of the branch changed in a way that a save does not show, such as a name. */
  | { type: "history" }
  /**
   * The branch list changed. A browser on a renamed branch continues on the new name. A browser
   * on a deleted branch, or one that connects to a branch that does not exist, opens `main`.
   */
  | { type: "branches"; renamed?: { from: string; to: string }; deleted?: string };

/** JSON messages from the browser that are not saves. */
export type ClientMessage =
  | { type: "takeover" }
  /**
   * Adds a new version to the branch with a copy of the scene of `versionId`. Only the editor of
   * the branch can restore, and only from the newest version (`baseHash`).
   */
  | { type: "restore"; versionId: number; baseHash: string | null };

/**
 * Binary messages carry a scene: a 4-byte length, a JSON header, and the gzip scene bytes.
 * The browser sends `save` frames. The server sends `scene` frames.
 */
export type FrameHeader =
  | { type: "save"; baseHash: string | null }
  /** `restored` is true when the scene is a restore, so the browser replaces its scene. */
  | { type: "scene"; head: Head; restored?: boolean };

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

/** The signed-in person, from their Google account. The name is the author of each version. */
export interface User {
  id: string;
  email: string;
  name: string;
  /** URL of the Google profile picture, or empty. */
  picture: string;
}

export interface HealthResponse {
  ok: boolean;
  /** Cloudflare data center that received the request. */
  colo: string;
}
