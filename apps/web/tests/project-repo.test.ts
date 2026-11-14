import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSocketPath, type ServerMessage } from "@draw/shared";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

// Vite+ ships Vitest 5, and @cloudflare/vitest-pool-workers needs Vitest 4, so the test
// runs the real Worker and Durable Object in workerd through Wrangler.
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    // The Cloudflare Vite plugin supplies the assets in dev and build. This test needs only the API.
    assets: await mkdtemp(join(tmpdir(), "draw-assets-")),
    dev: { server: { port: 0 }, inspector: false, persist: false },
  });
}, 60_000);

afterAll(() => worker?.dispose());

async function connect(projectId: string) {
  const url = new URL(projectSocketPath(projectId), await worker.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const next = () =>
    inbox.length > 0
      ? Promise.resolve(inbox.shift()!)
      : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
  expect((await next()).type).toBe("hello");
  return { ws, next };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a binary save is stored in the project and survives a new connection", async () => {
  const first = await connect("project-a");
  const payload = randomBytes(300 * 1024);
  first.ws.send(payload);
  expect(await first.next()).toEqual({
    type: "saved",
    versionId: 1,
    size: payload.byteLength,
    hash: sha256(payload),
  });
  first.ws.close();

  // Version ids continue in the same project, so the first row is in its SQLite storage.
  const second = await connect("project-a");
  second.ws.send(new Uint8Array([1, 2, 3]));
  expect(await second.next()).toMatchObject({ type: "saved", versionId: 2, size: 3 });
  second.ws.close();

  // Each project has its own Durable Object.
  const other = await connect("project-b");
  other.ws.send(new Uint8Array([1]));
  expect(await other.next()).toMatchObject({ type: "saved", versionId: 1 });
  other.ws.close();
});

test("a text message is refused", async () => {
  const { ws, next } = await connect("project-c");
  ws.send("not a scene");
  expect(await next()).toEqual({ type: "error", message: "A save must be a binary message" });
  ws.close();
});
