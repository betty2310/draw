import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  branchPath,
  decodeFrame,
  encodeFrame,
  projectImagePath,
  projectSocketPath,
  versionPath,
  type BranchInfo,
  type FrameHeader,
  type Project,
  type ServerMessage,
  type VersionInfo,
} from "@draw/shared";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

// Vite+ ships Vitest 5, and @cloudflare/vitest-pool-workers needs Vitest 4, so the test
// runs the real Worker and Durable Object in workerd through Wrangler.
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    // The production Worker with routes that move the clock and run the delete of old versions.
    entrypoint: fileURLToPath(new URL("../../../packages/server/test/worker.ts", import.meta.url)),
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
  opts: { client: string; author: string; known?: string; branch?: string },
) {
  const url = new URL(
    projectSocketPath(projectId, {
      branch: opts.branch ?? "main",
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
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  const hello = await next();
  if (hello.type !== "hello") throw new Error(`Expected hello, got ${hello.type}`);
  /** Saves and returns the head that the server replies with. */
  const saveOk = async (baseHash: string | null, scene: Uint8Array) => {
    save(baseHash, scene);
    const reply = await next();
    if (reply.type !== "saved") throw new Error(`Expected saved, got ${reply.type}`);
    return reply.head;
  };
  return { ws, next, save, saveOk, hello, inbox, closed };
}

async function call<T>(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, await worker.url), init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const versions = async (projectId: string, branch = "main") =>
  (await call<VersionInfo[]>(`${versionPath(projectId)}?branch=${encodeURIComponent(branch)}`))
    .body;

const moveClock = async (projectId: string, ms: number) =>
  fetch(new URL(`/test/${projectId}/clock?ms=${ms}`, await worker.url));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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

test("version rules: a new version after 5 minutes, and a name closes the version", async () => {
  const a = await connect("p-rules", { client: "tab", author: "An" });
  const v1 = await a.saveOk(null, randomBytes(100));
  await moveClock("p-rules", 4 * MINUTE);
  const v1b = await a.saveOk(v1.hash, randomBytes(100));
  expect(v1b.versionId).toBe(v1.versionId);

  // 5 minutes after the creation of the version, the save adds a new version.
  await moveClock("p-rules", 1 * MINUTE);
  const v2 = await a.saveOk(v1b.hash, randomBytes(100));
  expect(v2.versionId).toBeGreaterThan(v1.versionId);

  // A name closes the version early, and each socket of the branch learns of it.
  const named = await call<VersionInfo>(
    versionPath("p-rules", v2.versionId),
    json("PATCH", { name: " Draft 1 " }),
  );
  expect(named.body).toMatchObject({ id: v2.versionId, name: "Draft 1", author: "An" });
  expect(await a.next()).toEqual({ type: "history" });
  const v3 = await a.saveOk(v2.hash, randomBytes(100));
  expect(v3.versionId).toBeGreaterThan(v2.versionId);

  // The list is newest first, and the filter shows the named versions only.
  expect((await versions("p-rules")).map((v) => v.id)).toEqual([
    v3.versionId,
    v2.versionId,
    v1.versionId,
  ]);
  const namedOnly = await call<VersionInfo[]>(`${versionPath("p-rules")}?named=1`);
  expect(namedOnly.body.map((v) => v.name)).toEqual(["Draft 1"]);

  // An empty name removes the name.
  await call(versionPath("p-rules", v2.versionId), json("PATCH", { name: "" }));
  expect((await versions("p-rules")).find((v) => v.id === v2.versionId)?.name).toBe("");
  expect((await call(versionPath("p-rules", 9999), json("PATCH", { name: "x" }))).status).toBe(404);
  a.ws.close();
});

test("restore adds a new version with a copy of the old scene, and removes no version", async () => {
  const editor = await connect("p-restore", { client: "tab-a", author: "An" });
  const viewer = await connect("p-restore", { client: "tab-b", author: "Binh" });
  const old = randomBytes(3000);
  const v1 = await editor.saveOk(null, old);
  await viewer.next();
  await moveClock("p-restore", 6 * MINUTE);
  const v2 = await editor.saveOk(v1.hash, randomBytes(3000));
  await viewer.next();

  // A viewer cannot restore.
  viewer.ws.send(JSON.stringify({ type: "restore", versionId: v1.versionId, baseHash: v2.hash }));
  expect(await viewer.next()).toMatchObject({ type: "error" });

  // A restore from an old scene is refused, so it cannot replace a save that the browser did not see.
  editor.ws.send(JSON.stringify({ type: "restore", versionId: v1.versionId, baseHash: v1.hash }));
  expect(await editor.next()).toMatchObject({ type: "conflict", head: { hash: v2.hash } });
  await editor.next();

  editor.ws.send(JSON.stringify({ type: "restore", versionId: v1.versionId, baseHash: v2.hash }));
  for (const socket of [editor, viewer]) {
    const frame = await socket.next();
    expect(frame.type === "scene" && frame.header).toMatchObject({
      type: "scene",
      restored: true,
      head: { hash: sha256(old), author: "An" },
    });
    expect(frame.type === "scene" && frame.body.equals(old)).toBe(true);
  }
  const list = await versions("p-restore");
  expect(list.map((v) => v.id).slice(1)).toEqual([v2.versionId, v1.versionId]);
  expect(list[0]!.id).toBeGreaterThan(v2.versionId);

  // The restored version is a new version, so the next save does not change the old one.
  const v4 = await editor.saveOk(sha256(old), randomBytes(10));
  expect(v4.versionId).toBe(list[0]!.id);
  const bytes = Buffer.from(
    await (
      await fetch(new URL(`${versionPath("p-restore", v1.versionId)}/scene`, await worker.url))
    ).arrayBuffer(),
  );
  expect(bytes.equals(old)).toBe(true);
  editor.ws.close();
  viewer.ws.close();
});

test("branches: create from a version, edit apart, rename and delete", async () => {
  const main = await connect("p-branch", { client: "tab-a", author: "An" });
  const base = randomBytes(2000);
  const v1 = await main.saveOk(null, base);

  const created = await call<BranchInfo>(
    branchPath("p-branch"),
    json("POST", { name: " idea ", fromVersionId: v1.versionId, author: "Binh" }),
  );
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    name: "idea",
    fromVersionId: v1.versionId,
    fromBranch: "main",
  });
  expect(await main.next()).toEqual({ type: "history" });
  expect(await main.next()).toEqual({ type: "branches" });
  expect((await versions("p-branch"))[0]!.branches).toEqual(["idea"]);

  // The version that a branch was created from is closed, so the next save on main adds a version.
  const v2 = await main.saveOk(v1.hash, randomBytes(2000));
  expect(v2.versionId).toBeGreaterThan(v1.versionId);

  // The new branch starts with a copy of the scene, and the first person who opens it edits it.
  const idea = await connect("p-branch", { client: "tab-b", author: "Binh", branch: "idea" });
  expect(idea.hello).toMatchObject({
    role: "editor",
    head: { hash: sha256(base), author: "Binh" },
  });
  const first = await idea.next();
  expect(first.type === "scene" && first.body.equals(base)).toBe(true);
  const ideaSave = await idea.saveOk(sha256(base), randomBytes(500));
  expect((await versions("p-branch", "idea")).map((v) => v.id)).toEqual([ideaSave.versionId]);
  expect((await versions("p-branch")).map((v) => v.id)).toEqual([v2.versionId, v1.versionId]);

  expect(
    (
      await call(
        branchPath("p-branch"),
        json("POST", { name: "idea", fromVersionId: v1.versionId, author: "An" }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        branchPath("p-branch"),
        json("POST", { name: "x", fromVersionId: 9999, author: "An" }),
      )
    ).status,
  ).toBe(404);

  // Rename: the open socket continues on the new name and can still save.
  const renamed = await call<BranchInfo>(
    branchPath("p-branch", "idea"),
    json("PATCH", { name: "idea 2" }),
  );
  expect(renamed.body.name).toBe("idea 2");
  expect(await idea.next()).toEqual({ type: "branches", renamed: { from: "idea", to: "idea 2" } });
  await main.next();
  const after = await idea.saveOk(ideaSave.hash, randomBytes(500));
  expect((await versions("p-branch", "idea 2"))[0]!.id).toBe(after.versionId);
  expect((await versions("p-branch"))[1]!.branches).toEqual(["idea 2"]);

  // main cannot be renamed or deleted.
  expect(
    (await call(branchPath("p-branch", "main"), json("PATCH", { name: "trunk" }))).status,
  ).toBe(400);
  expect((await call(branchPath("p-branch", "main"), { method: "DELETE" })).status).toBe(400);

  // Delete: the versions of the branch go, the sockets close, and main keeps its versions.
  expect((await call(branchPath("p-branch", "idea 2"), { method: "DELETE" })).status).toBe(204);
  expect(await idea.next()).toEqual({ type: "branches", deleted: "idea 2" });
  expect(await idea.closed).toBe(4004);
  expect(await versions("p-branch", "idea 2")).toEqual([]);
  expect((await call<BranchInfo[]>(branchPath("p-branch"))).body.map((b) => b.name)).toEqual([
    "main",
  ]);
  expect((await versions("p-branch")).map((v) => v.id)).toEqual([v2.versionId, v1.versionId]);

  // A browser that comes back to the deleted branch learns that it must open main.
  const lateUrl = new URL(
    projectSocketPath("p-branch", { branch: "idea 2", author: "An", client: "c", known: "" }),
    await worker.url,
  );
  lateUrl.protocol = "ws:";
  const late = new WebSocket(lateUrl);
  const message = await new Promise<string>((resolve) =>
    late.addEventListener("message", (event) => resolve(event.data as string)),
  );
  expect(JSON.parse(message)).toEqual({ type: "branches", deleted: "idea 2" });
  main.ws.close();
});

test("the delete of old versions keeps named, newest and branched-from versions", async () => {
  const id = "p-cleanup";
  const a = await connect(id, { client: "tab", author: "An" });
  const ids: number[] = [];
  let hash: string | null = null;
  for (let i = 0; i < 5; i++) {
    const head = await a.saveOk(hash, randomBytes(100));
    ids.push(head.versionId);
    hash = head.hash;
    await moveClock(id, 6 * MINUTE);
  }
  // The first save scheduled the delete for one day later.
  const scheduled = (await call<{ next: number; now: number }>(`/test/${id}/alarm`)).body;
  expect(scheduled.next).toBeGreaterThan(scheduled.now);
  expect(scheduled.next).toBeLessThanOrEqual(scheduled.now + DAY);

  await call(versionPath(id, ids[1]!), json("PATCH", { name: "Keep" }));
  await a.next();
  await call(branchPath(id), json("POST", { name: "b", fromVersionId: ids[2]!, author: "An" }));
  await a.next();
  await a.next();

  // At 29 days nothing is deleted.
  await moveClock(id, 29 * DAY);
  await call(`/test/${id}/cleanup`);
  expect((await versions(id)).length).toBe(5);

  // After 30 days the versions with no name go, except the newest one and the one of branch b.
  await moveClock(id, 1 * DAY + MINUTE);
  const run = (await call<{ next: number | null; now: number }>(`/test/${id}/cleanup`)).body;
  expect(await a.next()).toEqual({ type: "history" });
  expect((await versions(id)).map((v) => v.id)).toEqual([ids[4], ids[2], ids[1]]);
  // Each kept version is protected, so the project does not wake each day.
  expect(run.next).toBeNull();
  expect((await versions(id, "b")).length).toBe(1);
  a.ws.close();
});
