/** Path of the WebSocket of one project. */
export function projectSocketPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ws`;
}

/**
 * Messages from the project Durable Object to the browser.
 * The browser sends a save as one binary message that holds the scene bytes.
 */
export type ServerMessage =
  | { type: "hello"; colo: string }
  | { type: "saved"; versionId: number; size: number; hash: string }
  | { type: "error"; message: string };

export interface HealthResponse {
  ok: boolean;
  /** Cloudflare data center that received the request. */
  colo: string;
}
