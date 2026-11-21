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
  type User,
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
    // The production Worker with routes that move the clock and run the delete of old versions,
    // and a fake Google token endpoint.
    entrypoint: fileURLToPath(new URL("../../../packages/server/test/worker.ts", import.meta.url)),
    // The Cloudflare Vite plugin supplies the assets in dev and build. This test needs only the API.
    assets: await mkdtemp(join(tmpdir(), "draw-assets-")),
    bindings: { GOOGLE_CLIENT_SECRET: { type: "plain_text", value: "test-secret" } },
    dev: { server: { port: 0 }, inspector: false, persist: false },
  });
  an = await signIn({ sub: "google-an", name: AN });
}, 60_000);

afterAll(() => worker?.dispose());

/** The Vietnamese name checks that the ID token is decoded as UTF-8. */
const AN = "Nguyễn Văn An";
/** The session cookie of An. Most tests use it. */
let an: string;

type Claims = {
  sub: string;
  name: string;
  nonce?: string;
  aud?: string;
  email_verified?: boolean;
};

/**
 * Signs in with the fake Google of the test Worker, as a browser does: open the start route, get
 * the state, the nonce and the PKCE challenge from the redirect, and come back with a code.
 */
async function startSignIn(next = "/") {
  const start = await fetch(
    new URL(`/api/auth/google?next=${encodeURIComponent(next)}`, await worker.url),
    { redirect: "manual" },
  );
  const google = new URL(start.headers.get("Location")!);
  return {
    google,
    params: Object.fromEntries(google.searchParams) as Record<string, string>,
    cookie: start.headers.getSetCookie()[0]!.split(";")[0]!,
  };
}

async function finishSignIn(
  { params, cookie }: Awaited<ReturnType<typeof startSignIn>>,
  claims: Claims,
  state = params.state!,
) {
  const code = Buffer.from(
    JSON.stringify({
      claims: {
        iss: "https://accounts.google.com",
        aud: params.client_id,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: params.nonce,
        email: `${claims.sub}@example.com`,
        email_verified: true,
        picture: `https://lh3.googleusercontent.com/${claims.sub}`,
        ...claims,
      },
      challenge: params.code_challenge,
    }),
  ).toString("base64");
  const back = await fetch(
    new URL(`/api/auth/google/callback?${new URLSearchParams({ code, state })}`, await worker.url),
    { redirect: "manual", headers: { Cookie: cookie } },
  );
  const session = back.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-draw_session=") && !c.includes("Max-Age=0"));
  return { location: back.headers.get("Location"), session: session?.split(";")[0] };
}

/** Returns the session cookie. */
async function signIn(claims: Claims) {
  const { session } = await finishSignIn(await startSignIn(), claims);
  if (!session) throw new Error("No session cookie");
  return session;
}

type Received = ServerMessage | { type: "scene"; header: FrameHeader; body: Buffer };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function socketUrl(projectId: string, params: Record<string, string>) {
  const url = new URL(
    `${projectSocketPath(projectId)}?${new URLSearchParams(params)}`,
    await worker.url,
  );
  url.protocol = "ws:";
  return url;
}

/** Opens a socket that the Worker refuses, and returns its close code. */
async function refusedSocket(projectId: string, cookie?: string) {
  const ws = new WebSocket(await socketUrl(projectId, { branch: "main", client: "c", known: "" }), {
    headers: cookie ? { Cookie: cookie } : {},
  } as never);
  return new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
}

async function connect(
  projectId: string,
  opts: { client: string; known?: string; branch?: string; cookie?: string; author?: string },
) {
  const params: Record<string, string> = {
    branch: opts.branch ?? "main",
    client: opts.client,
    known: opts.known ?? "",
  };
  // The server must not take the author from the browser.
  if (opts.author) params.author = opts.author;
  // Node's WebSocket takes headers, so the test sends the session cookie as a browser does.
  const ws = new WebSocket(await socketUrl(projectId, params), {
    headers: { Cookie: opts.cookie ?? an },
  } as never);
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

/** Sends the cookie and the `Origin` header, as the browser does for a same-site request. */
async function call<T>(path: string, init?: RequestInit, cookie: string | null = an) {
  const url = new URL(path, await worker.url);
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string>),
      Origin: url.origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Creates a project in the workspace of the user, and returns its id. */
const newProject = async (cookie = an) =>
  (await call<Project>("/api/projects", json("POST", { name: "Test" }), cookie)).body.id;

const versions = async (projectId: string, branch = "main") =>
  (await call<VersionInfo[]>(`${versionPath(projectId)}?branch=${encodeURIComponent(branch)}`))
    .body;

const moveClock = async (projectId: string, ms: number) =>
  fetch(new URL(`/test/${projectId}/clock?ms=${ms}`, await worker.url));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test("autosave writes into the open version, and a new connection gets the newest scene", async () => {
  const id = await newProject();
  const a = await connect(id, { client: "tab-1" });
  expect(a.hello).toMatchObject({ role: "editor", editor: AN, head: null });

  const first = randomBytes(300 * 1024);
  a.save(null, first);
  const saved1 = await a.next();
  expect(saved1).toMatchObject({ type: "saved", head: { hash: sha256(first), author: AN } });

  // Within 5 minutes and by the same person, the save replaces the scene of the same version.
  const second = randomBytes(1000);
  a.save(sha256(first), second);
  const saved2 = await a.next();
  expect(saved2.type === "saved" && saved2.head.versionId).toBe(
    saved1.type === "saved" && saved1.head.versionId,
  );
  a.ws.close();

  // A browser that has an old copy gets the newest scene. One that has the newest gets no scene.
  const old = await connect(id, { client: "tab-2", known: sha256(first) });
  expect(old.hello).toMatchObject({ head: { hash: sha256(second) } });
  const scene = await old.next();
  expect(scene.type === "scene" && scene.body.equals(second)).toBe(true);
  old.ws.close();

  const current = await connect(id, { client: "tab-3", known: sha256(second) });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(current.inbox).toEqual([]);
  current.ws.close();
});

test("a save with an old hash is refused and gets the current scene", async () => {
  const a = await connect(await newProject(), { client: "tab-1" });
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

test("the first tab edits, the second views each save and can take over", async () => {
  const id = await newProject();
  const editor = await connect(id, { client: "tab-a" });
  const viewer = await connect(id, { client: "tab-b" });
  expect(viewer.hello).toMatchObject({ role: "viewer", editor: AN });

  const scene = randomBytes(5000);
  editor.save(null, scene);
  await editor.next();
  const shown = await viewer.next();
  expect(shown.type === "scene" && shown.body.equals(scene)).toBe(true);

  // A viewer cannot save.
  viewer.save(sha256(scene), randomBytes(10));
  expect(await viewer.next()).toMatchObject({ type: "error" });

  viewer.ws.send(JSON.stringify({ type: "takeover" }));
  expect(await viewer.next()).toEqual({ type: "role", role: "editor", editor: AN });
  expect(await editor.next()).toEqual({ type: "role", role: "viewer", editor: AN });

  const next = randomBytes(10);
  viewer.save(sha256(scene), next);
  const saved = await viewer.next();
  expect(saved).toMatchObject({ type: "saved", head: { author: AN, hash: sha256(next) } });
  editor.ws.close();
  viewer.ws.close();
});

test("the same tab that connects again keeps the edit lock", async () => {
  const id = await newProject();
  const first = await connect(id, { client: "tab-a" });
  const viewer = await connect(id, { client: "tab-b" });
  // The network of tab-a changed, and the old socket is not closed yet.
  const again = await connect(id, { client: "tab-a" });
  expect(again.hello).toMatchObject({ role: "editor" });
  expect(await viewer.next()).toEqual({ type: "role", role: "viewer", editor: AN });
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
        headers: { "Content-Type": "image/png", Cookie: an },
      })
    ).status,
  ).toBe(204);
  const got = await fetch(new URL(path, base), { headers: { Cookie: an } });
  expect(got.headers.get("Content-Type")).toBe("image/png");
  expect(got.headers.get("Cache-Control")).toContain("private");
  expect(Buffer.from(await got.arrayBuffer()).equals(image)).toBe(true);
  const tooLarge = await fetch(new URL(projectImagePath(id, "big"), base), {
    method: "PUT",
    body: randomBytes(1.5 * 1024 * 1024 + 1),
    headers: { Cookie: an, Origin: base.origin },
  });
  expect(tooLarge.status).toBe(413);

  // The editor learns which images the server has.
  const socket = await connect(id, { client: "tab" });
  expect(socket.hello).toMatchObject({ imageIds: ["file-1"] });
  socket.ws.close();
});

test("version rules: a new version after 5 minutes, and a name closes the version", async () => {
  const id = await newProject();
  const a = await connect(id, { client: "tab" });
  const v1 = await a.saveOk(null, randomBytes(100));
  await moveClock(id, 4 * MINUTE);
  const v1b = await a.saveOk(v1.hash, randomBytes(100));
  expect(v1b.versionId).toBe(v1.versionId);

  // 5 minutes after the creation of the version, the save adds a new version.
  await moveClock(id, 1 * MINUTE);
  const v2 = await a.saveOk(v1b.hash, randomBytes(100));
  expect(v2.versionId).toBeGreaterThan(v1.versionId);

  // A name closes the version early, and each socket of the branch learns of it.
  const named = await call<VersionInfo>(
    versionPath(id, v2.versionId),
    json("PATCH", { name: " Draft 1 " }),
  );
  expect(named.body).toMatchObject({ id: v2.versionId, name: "Draft 1", author: AN });
  expect(await a.next()).toEqual({ type: "history" });
  const v3 = await a.saveOk(v2.hash, randomBytes(100));
  expect(v3.versionId).toBeGreaterThan(v2.versionId);

  // The list is newest first, and the filter shows the named versions only.
  expect((await versions(id)).map((v) => v.id)).toEqual([v3.versionId, v2.versionId, v1.versionId]);
  const namedOnly = await call<VersionInfo[]>(`${versionPath(id)}?named=1`);
  expect(namedOnly.body.map((v) => v.name)).toEqual(["Draft 1"]);

  // An empty name removes the name.
  await call(versionPath(id, v2.versionId), json("PATCH", { name: "" }));
  expect((await versions(id)).find((v) => v.id === v2.versionId)?.name).toBe("");
  expect((await call(versionPath(id, 9999), json("PATCH", { name: "x" }))).status).toBe(404);
  a.ws.close();
});

test("restore adds a new version with a copy of the old scene, and removes no version", async () => {
  const id = await newProject();
  const editor = await connect(id, { client: "tab-a" });
  const viewer = await connect(id, { client: "tab-b" });
  const old = randomBytes(3000);
  const v1 = await editor.saveOk(null, old);
  await viewer.next();
  await moveClock(id, 6 * MINUTE);
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
      head: { hash: sha256(old), author: AN },
    });
    expect(frame.type === "scene" && frame.body.equals(old)).toBe(true);
  }
  const list = await versions(id);
  expect(list.map((v) => v.id).slice(1)).toEqual([v2.versionId, v1.versionId]);
  expect(list[0]!.id).toBeGreaterThan(v2.versionId);

  // The restored version is a new version, so the next save does not change the old one.
  const v4 = await editor.saveOk(sha256(old), randomBytes(10));
  expect(v4.versionId).toBe(list[0]!.id);
  const bytes = Buffer.from(
    await (
      await fetch(new URL(`${versionPath(id, v1.versionId)}/scene`, await worker.url), {
        headers: { Cookie: an },
      })
    ).arrayBuffer(),
  );
  expect(bytes.equals(old)).toBe(true);
  editor.ws.close();
  viewer.ws.close();
});

test("branches: create from a version, edit apart, rename and delete", async () => {
  const id = await newProject();
  const main = await connect(id, { client: "tab-a" });
  const base = randomBytes(2000);
  const v1 = await main.saveOk(null, base);

  const created = await call<BranchInfo>(
    branchPath(id),
    // The author comes from the session. The server ignores an author in the body.
    json("POST", { name: " idea ", fromVersionId: v1.versionId, author: "Mallory" }),
  );
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    name: "idea",
    fromVersionId: v1.versionId,
    fromBranch: "main",
  });
  expect(await main.next()).toEqual({ type: "history" });
  expect(await main.next()).toEqual({ type: "branches" });
  expect((await versions(id))[0]!.branches).toEqual(["idea"]);

  // The version that a branch was created from is closed, so the next save on main adds a version.
  const v2 = await main.saveOk(v1.hash, randomBytes(2000));
  expect(v2.versionId).toBeGreaterThan(v1.versionId);

  // The new branch starts with a copy of the scene, and the first person who opens it edits it.
  const idea = await connect(id, { client: "tab-b", branch: "idea" });
  expect(idea.hello).toMatchObject({
    role: "editor",
    head: { hash: sha256(base), author: AN },
  });
  const first = await idea.next();
  expect(first.type === "scene" && first.body.equals(base)).toBe(true);
  const ideaSave = await idea.saveOk(sha256(base), randomBytes(500));
  expect((await versions(id, "idea")).map((v) => v.id)).toEqual([ideaSave.versionId]);
  expect((await versions(id)).map((v) => v.id)).toEqual([v2.versionId, v1.versionId]);

  // The History panel lists the versions of all branches, newest first, and each panel
  // refreshes when a version of any branch gets a name.
  const all = await call<VersionInfo[]>(`${versionPath(id)}?all=1`);
  expect(all.body.map((v) => [v.id, v.branch])).toEqual([
    [v2.versionId, "main"],
    [ideaSave.versionId, "idea"],
    [v1.versionId, "main"],
  ]);
  await call(versionPath(id, v1.versionId), json("PATCH", { name: "Base" }));
  expect(await idea.next()).toEqual({ type: "history" });
  expect(await main.next()).toEqual({ type: "history" });
  const named = await call<VersionInfo[]>(`${versionPath(id)}?all=1&named=1`);
  expect(named.body.map((v) => v.id)).toEqual([v1.versionId]);
  // A new version on one branch refreshes the panel on the other branches too.
  await moveClock(id, 6 * MINUTE);
  const ideaNext = await idea.saveOk(ideaSave.hash, randomBytes(500));
  expect(await main.next()).toEqual({ type: "history" });

  expect(
    (await call(branchPath(id), json("POST", { name: "idea", fromVersionId: v1.versionId })))
      .status,
  ).toBe(409);
  expect(
    (await call(branchPath(id), json("POST", { name: "x", fromVersionId: 9999 }))).status,
  ).toBe(404);

  // Rename: the open socket continues on the new name and can still save.
  const renamed = await call<BranchInfo>(branchPath(id, "idea"), json("PATCH", { name: "idea 2" }));
  expect(renamed.body.name).toBe("idea 2");
  expect(await idea.next()).toEqual({ type: "branches", renamed: { from: "idea", to: "idea 2" } });
  await main.next();
  const after = await idea.saveOk(ideaNext.hash, randomBytes(500));
  expect((await versions(id, "idea 2"))[0]!.id).toBe(after.versionId);
  expect((await versions(id))[1]!.branches).toEqual(["idea 2"]);

  // main cannot be renamed or deleted.
  expect((await call(branchPath(id, "main"), json("PATCH", { name: "trunk" }))).status).toBe(400);
  expect((await call(branchPath(id, "main"), { method: "DELETE" })).status).toBe(400);

  // Delete: the versions of the branch go, the sockets close, and main keeps its versions.
  expect((await call(branchPath(id, "idea 2"), { method: "DELETE" })).status).toBe(204);
  expect(await idea.next()).toEqual({ type: "branches", deleted: "idea 2" });
  expect(await idea.closed).toBe(4004);
  expect(await versions(id, "idea 2")).toEqual([]);
  expect((await call<BranchInfo[]>(branchPath(id))).body.map((b) => b.name)).toEqual(["main"]);
  expect((await versions(id)).map((v) => v.id)).toEqual([v2.versionId, v1.versionId]);

  // A browser that comes back to the deleted branch learns that it must open main.
  const late = new WebSocket(await socketUrl(id, { branch: "idea 2", client: "c", known: "" }), {
    headers: { Cookie: an },
  } as never);
  const message = await new Promise<string>((resolve) =>
    late.addEventListener("message", (event) => resolve(event.data as string)),
  );
  expect(JSON.parse(message)).toEqual({ type: "branches", deleted: "idea 2" });
  main.ws.close();
});

test("the delete of old versions keeps named, newest and branched-from versions", async () => {
  const id = await newProject();
  const a = await connect(id, { client: "tab" });
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
  await call(branchPath(id), json("POST", { name: "b", fromVersionId: ids[2]! }));
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

test("accounts: Google sign-in, sessions, and one workspace for each user", async () => {
  // No session: the API and the socket refuse.
  expect((await call("/api/projects", undefined, null)).status).toBe(401);
  expect((await call("/api/auth/me", undefined, null)).status).toBe(401);
  expect(await refusedSocket(await newProject())).toBe(4401);

  expect((await call<User>("/api/auth/me")).body).toMatchObject({
    name: AN,
    email: "google-an@example.com",
    picture: "https://lh3.googleusercontent.com/google-an",
  });

  // A second user has an empty workspace and cannot reach a project of An.
  const binh = await signIn({ sub: "google-binh", name: "Binh" });
  const id = await newProject();
  const owner = await connect(id, { client: "tab" });
  const head = await owner.saveOk(null, randomBytes(100));
  await call(projectImagePath(id, "img"), { method: "PUT", body: randomBytes(10) });
  expect((await call<Project[]>("/api/projects", undefined, binh)).body).toEqual([]);
  for (const [path, init] of [
    [`/api/projects/${id}`, undefined],
    [`/api/projects/${id}`, json("PATCH", { name: "Taken" })],
    [versionPath(id), undefined],
    [`${versionPath(id, head.versionId)}/scene`, undefined],
    [versionPath(id, head.versionId), json("PATCH", { name: "x" })],
    [branchPath(id), undefined],
    [branchPath(id), json("POST", { name: "b", fromVersionId: head.versionId })],
    [projectImagePath(id, "img"), undefined],
    [projectImagePath(id, "other"), { method: "PUT", body: randomBytes(10) }],
  ] as const) {
    expect([path, init?.method, (await call(path, init, binh)).status]).toEqual([
      path,
      init?.method,
      404,
    ]);
  }
  expect(await refusedSocket(id, binh)).toBe(4404);
  expect((await call<Project>(`/api/projects/${id}`)).body.name).toBe("Test");

  // The author of a save comes from the session, not from the socket URL.
  const spoof = await connect(id, { client: "tab", author: "Mallory", known: head.hash });
  expect((await spoof.saveOk(head.hash, randomBytes(100))).author).toBe(AN);
  owner.ws.close();
  spoof.ws.close();

  // A second sign-in with the same Google account is the same user, with the new Google name.
  const again = await signIn({ sub: "google-binh", name: "Binh Trần" });
  const binhProject = await newProject(again);
  expect((await call<User>("/api/auth/me", undefined, binh)).body.name).toBe("Binh Trần");
  expect((await call<Project[]>("/api/projects", undefined, binh)).body.map((p) => p.id)).toEqual([
    binhProject,
  ]);

  // Sign-out ends only that session.
  expect((await call("/api/auth/logout", { method: "POST" }, again)).status).toBe(204);
  expect((await call("/api/auth/me", undefined, again)).status).toBe(401);
  expect((await call("/api/auth/me", undefined, binh)).status).toBe(200);

  // The sign-in returns to the page that asked for it, but never to a different site.
  expect((await finishSignIn(await startSignIn("/p/abc"), { sub: "s1", name: "C" })).location).toBe(
    "/p/abc",
  );
  expect(
    (await finishSignIn(await startSignIn("//evil.example"), { sub: "s1", name: "C" })).location,
  ).toBe("/");

  // A forged or wrong return gives no session.
  const start = await startSignIn();
  expect(start.google.origin + start.google.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(start.params).toMatchObject({
    scope: "openid email profile",
    code_challenge_method: "S256",
  });
  for (const [claims, state] of [
    [{ sub: "s2", name: "D" }, "wrong-state"],
    [{ sub: "s2", name: "D", nonce: "wrong-nonce" }, undefined],
    [{ sub: "s2", name: "D", aud: "other-client" }, undefined],
    [{ sub: "s2", name: "D", email_verified: false } as Claims, undefined],
  ] as const) {
    expect(await finishSignIn(await startSignIn(), claims, state)).toEqual({
      location: "/?signin=failed",
      session: undefined,
    });
  }
  // The code must come with the PKCE verifier of the same sign-in.
  const first = await startSignIn();
  const second = await startSignIn();
  expect(
    await finishSignIn(
      { ...first, params: { ...first.params, code_challenge: second.params.code_challenge! } },
      {
        sub: "s3",
        name: "E",
      },
    ),
  ).toEqual({ location: "/?signin=failed", session: undefined });
});
