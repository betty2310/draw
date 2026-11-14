import {
  projectSocketPath,
  sha256Hex,
  type HealthResponse,
  type ServerMessage,
} from "@draw/shared";

export const PAYLOAD_SIZES = [50 * 1024, 300 * 1024, 1024 * 1024];
const SAVES_PER_SIZE = 10;

export interface SizeResult {
  size: number;
  /** Time from send to the "saved" reply, for each save, in milliseconds. */
  timesMs: number[];
}

export interface MeasureResult {
  projectId: string;
  workerColo: string;
  objectColo: string;
  connectMs: number;
  /** The first save also creates the Durable Object, so it is reported apart. */
  firstSaveMs: number;
  sizes: SizeResult[];
  userAgent: string;
  at: string;
}

/** Saves random bytes through the project WebSocket and times each save. */
export async function measureSaves(onProgress: (text: string) => void): Promise<MeasureResult> {
  const health = (await (await fetch("/api/health")).json()) as HealthResponse;
  const projectId = `measure-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  onProgress("Connecting");
  const connectStart = performance.now();
  const socket = await openSocket(projectId);
  const connectMs = performance.now() - connectStart;
  try {
    const hello = await socket.next();
    if (hello.type !== "hello") throw new Error(`Expected hello, got ${hello.type}`);

    onProgress("First save");
    const firstSaveMs = await timedSave(socket, randomBytes(1024));

    const sizes: SizeResult[] = [];
    for (const size of PAYLOAD_SIZES) {
      const timesMs: number[] = [];
      for (let run = 1; run <= SAVES_PER_SIZE; run++) {
        onProgress(`${formatSize(size)}: save ${run} of ${SAVES_PER_SIZE}`);
        timesMs.push(await timedSave(socket, randomBytes(size)));
      }
      sizes.push({ size, timesMs });
    }
    return {
      projectId,
      workerColo: health.colo,
      objectColo: hello.colo,
      connectMs,
      firstSaveMs,
      sizes,
      userAgent: navigator.userAgent,
      at: new Date().toISOString(),
    };
  } finally {
    socket.close();
  }
}

/** Sends one save and checks that the server stored the same bytes. */
async function timedSave(socket: Socket, payload: Uint8Array<ArrayBuffer>): Promise<number> {
  const expectedHash = await sha256Hex(payload);
  const start = performance.now();
  socket.send(payload);
  const reply = await socket.next();
  const elapsed = performance.now() - start;
  if (reply.type !== "saved") throw new Error(`Save failed: ${JSON.stringify(reply)}`);
  if (reply.hash !== expectedHash || reply.size !== payload.byteLength) {
    throw new Error("The server stored different bytes");
  }
  return elapsed;
}

interface Socket {
  send(data: Uint8Array<ArrayBuffer>): void;
  next(): Promise<ServerMessage>;
  close(): void;
}

function openSocket(projectId: string): Promise<Socket> {
  const url = new URL(projectSocketPath(projectId), location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const queue: ServerMessage[] = [];
  const waiters: Array<{ resolve: (m: ServerMessage) => void; reject: (e: Error) => void }> = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  ws.addEventListener("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("The WebSocket closed"));
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("The WebSocket did not connect")));
    ws.addEventListener("open", () =>
      resolve({
        send: (data) => ws.send(data),
        next: () => {
          const queued = queue.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        close: () => ws.close(),
      }),
    );
  });
}

/** Random bytes do not compress, like the gzip scene that the editor will send. */
function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  // getRandomValues fills at most 65536 bytes for each call.
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  return bytes;
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}
