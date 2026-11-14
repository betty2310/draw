import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFrame,
  encodeFrame,
  projectImagePath,
  projectSocketPath,
  type FrameHeader,
  type Project,
  type ServerMessage,
} from "@draw/shared";
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

type Received = ServerMessage | { type: "scene"; header: FrameHeader; body: Buffer };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function connect(
  projectId: string,
  opts: { client: string; author: string; known?: string },
) {
  const url = new URL(
    projectSocketPath(projectId, {
      branch: "main",
      author: opts.author,
      client: opts.client,
      known: opts.known ?? "",
    }),
    await worker.url,
  );
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const inbox: Received[] = [];
  const waiters: Array<(message: Received) => void> = [];
  ws.addEventListener("message", (event) => {
    const message: Received =
      typeof event.data === "string"
        ? (JSON.parse(event.data) as ServerMessage)
        : (() => {
            const { header, body } = decodeFrame(event.data as ArrayBuffer);
            return { type: "scene" as const, header, body: Buffer.from(body) };
          })();
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
      : new Promise<Received>((resolve) => waiters.push(resolve));
  const save = (baseHash: string | null, scene: Uint8Array) =>
    ws.send(encodeFrame({ type: "save", baseHash }, scene));
  const hello = await next();
  if (hello.type !== "hello") throw new Error(`Expected hello, got ${hello.type}`);
  return { ws, next, save, hello, inbox };
}

test("autosave writes into the open version, and a new connection gets the newest scene", async () => {
  const a = await connect("p-open", { client: "tab-1", author: "An" });
  expect(a.hello).toMatchObject({ role: "editor", editor: "An", head: null });

  const first = randomBytes(300 * 1024);
  a.save(null, first);
  const saved1 = await a.next();
  expect(saved1).toMatchObject({ type: "saved", head: { hash: sha256(first), author: "An" } });

  // Within 5 minutes and by the same person, the save replaces the scene of the same version.
  const second = randomBytes(1000);
  a.save(sha256(first), second);
  const saved2 = await a.next();
  expect(saved2.type === "saved" && saved2.head.versionId).toBe(
    saved1.type === "saved" && saved1.head.versionId,
  );
  a.ws.close();

  // A browser that has an old copy gets the newest scene. One that has the newest gets no scene.
  const old = await connect("p-open", { client: "tab-2", author: "An", known: sha256(first) });
  expect(old.hello).toMatchObject({ head: { hash: sha256(second) } });
  const scene = await old.next();
  expect(scene.type === "scene" && scene.body.equals(second)).toBe(true);
  old.ws.close();

  const current = await connect("p-open", { client: "tab-3", author: "An", known: sha256(second) });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(current.inbox).toEqual([]);
  current.ws.close();
});

test("a save with an old hash is refused and gets the current scene", async () => {
  const a = await connect("p-conflict", { client: "tab-1", author: "An" });
  const current = randomBytes(2000);
  a.save(null, current);
  await a.next();

  // The browser was offline and did not see `current`.
  a.save(null, randomBytes(2000));
  expect(await a.next()).toMatchObject({ type: "conflict", head: { hash: sha256(current) } });
  const scene = await a.next();
  expect(scene.type === "scene" && scene.body.equals(current)).toBe(true);
  a.ws.close();
});

test("the first browser edits, the second views each save and can take over", async () => {
  const editor = await connect("p-lock", { client: "tab-a", author: "An" });
  const viewer = await connect("p-lock", { client: "tab-b", author: "Binh" });
  expect(viewer.hello).toMatchObject({ role: "viewer", editor: "An" });

  const scene = randomBytes(5000);
  editor.save(null, scene);
  await editor.next();
  const shown = await viewer.next();
  expect(shown.type === "scene" && shown.body.equals(scene)).toBe(true);

  // A viewer cannot save.
  viewer.save(sha256(scene), randomBytes(10));
  expect(await viewer.next()).toMatchObject({ type: "error" });

  viewer.ws.send(JSON.stringify({ type: "takeover" }));
  expect(await viewer.next()).toEqual({ type: "role", role: "editor", editor: "Binh" });
  expect(await editor.next()).toEqual({ type: "role", role: "viewer", editor: "Binh" });

  // A different person starts to edit, so the save adds a new version.
  const next = randomBytes(10);
  viewer.save(sha256(scene), next);
  const saved = await viewer.next();
  expect(saved).toMatchObject({ type: "saved", head: { author: "Binh", hash: sha256(next) } });
  editor.ws.close();
  viewer.ws.close();
});

test("the same tab that connects again keeps the edit lock", async () => {
  const first = await connect("p-reconnect", { client: "tab-a", author: "An" });
  const viewer = await connect("p-reconnect", { client: "tab-b", author: "Binh" });
  // The network of tab-a changed, and the old socket is not closed yet.
  const again = await connect("p-reconnect", { client: "tab-a", author: "An" });
  expect(again.hello).toMatchObject({ role: "editor" });
  expect(await viewer.next()).toEqual({ type: "role", role: "viewer", editor: "An" });
  first.ws.close();
  again.ws.close();
  viewer.ws.close();
});

test("projects: create, rename, trash, restore; images are stored in the project", async () => {
  const base = await worker.url;
  const call = async <T>(path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, base), init);
    return { status: response.status, body: (await response.json()) as T };
  };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const created = await call<Project>("/api/projects", json("POST", { name: "Mạng nhà" }));
  expect(created.status).toBe(201);
  const { id } = created.body;
  expect(
    (await call<Project>(`/api/projects/${id}`, json("PATCH", { name: "Renamed" }))).body.name,
  ).toBe("Renamed");

  await call(`/api/projects/${id}`, json("PATCH", { trashed: true }));
  const list = (await call<Project[]>("/api/projects")).body.map((p) => p.id);
  const trash = (await call<Project[]>("/api/projects?trash=1")).body.map((p) => p.id);
  expect([list.includes(id), trash.includes(id)]).toEqual([false, true]);

  await call(`/api/projects/${id}`, json("PATCH", { trashed: false }));
  expect((await call<Project[]>("/api/projects")).body.map((p) => p.id)).toContain(id);

  const image = randomBytes(4000);
  const path = projectImagePath(id, "file-1");
  expect(
    (
      await fetch(new URL(path, base), {
        method: "PUT",
        body: image,
        headers: { "Content-Type": "image/png" },
      })
    ).status,
  ).toBe(204);
  const got = await fetch(new URL(path, base));
  expect(got.headers.get("Content-Type")).toBe("image/png");
  expect(Buffer.from(await got.arrayBuffer()).equals(image)).toBe(true);
  const tooLarge = await fetch(new URL(projectImagePath(id, "big"), base), {
    method: "PUT",
    body: randomBytes(1.5 * 1024 * 1024 + 1),
  });
  expect(tooLarge.status).toBe(413);

  // The editor learns which images the server has.
  const socket = await connect(id, { client: "tab", author: "An" });
  expect(socket.hello).toMatchObject({ imageIds: ["file-1"] });
  socket.ws.close();
});
