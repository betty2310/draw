import {
  branchPath,
  gunzip,
  MAIN_BRANCH,
  versionPath,
  type BranchInfo,
  type Project,
  type ProjectPatch,
  type User,
  type VersionInfo,
} from "@draw/shared";

/** The session ended, for example after 30 days. The app shows the sign-in page. */
export const SIGNED_OUT_EVENT = "draw:signed-out";
export const signalSignedOut = () => dispatchEvent(new Event(SIGNED_OUT_EVENT));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (response.status === 401) signalSignedOut();
  if (!response.ok) {
    // The server explains a refused change, for example a branch name that exists.
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
}

export const listProjects = (trash: boolean) =>
  request<Project[]>(`/api/projects${trash ? "?trash=1" : ""}`);

export const getProject = (id: string) => request<Project>(`/api/projects/${id}`);

export const createProject = (name: string) =>
  request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });

export const updateProject = (id: string, patch: ProjectPatch) =>
  request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

/** The versions of all branches, newest first. */
export const listVersions = (projectId: string, namedOnly: boolean, limit: number) =>
  request<VersionInfo[]>(
    `${versionPath(projectId)}?${new URLSearchParams({ all: "1", named: namedOnly ? "1" : "0", limit: String(limit) })}`,
  );

/** The scene of a version as `.excalidraw` JSON. */
export async function getVersionScene(projectId: string, versionId: number): Promise<string> {
  const response = await fetch(`${versionPath(projectId, versionId)}/scene`);
  if (!response.ok) throw new Error(`The version could not be loaded (${response.status})`);
  return gunzip(new Uint8Array(await response.arrayBuffer()));
}

/** An empty name removes the name. */
export const nameVersion = (projectId: string, versionId: number, name: string) =>
  request<VersionInfo>(versionPath(projectId, versionId), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const listBranches = (projectId: string) => request<BranchInfo[]>(branchPath(projectId));

export const createBranch = (projectId: string, name: string, fromVersionId: number) =>
  request<BranchInfo>(branchPath(projectId), {
    method: "POST",
    body: JSON.stringify({ name, fromVersionId }),
  });

export const renameBranch = (projectId: string, from: string, to: string) =>
  request<BranchInfo>(branchPath(projectId, from), {
    method: "PATCH",
    body: JSON.stringify({ name: to }),
  });

export const deleteBranch = (projectId: string, name: string) =>
  request<null>(branchPath(projectId, name), { method: "DELETE" });

/** The page of a project. `main` has no branch in the URL. */
export const editorPath = (projectId: string, branch: string) =>
  `/p/${projectId}${branch === MAIN_BRANCH ? "" : `?${new URLSearchParams({ branch })}`}`;

/** The Google sign-in starts on the server. After it, the browser opens `next` again. */
export const signInUrl = (next: string) => `/api/auth/google?${new URLSearchParams({ next })}`;

/** This browser keeps the last user, so the app opens offline and you can draw. */
const USER_KEY = "draw.user";

/** The signed-in user, or null. Offline, it is the user of the last visit. */
export async function getMe(): Promise<User | null> {
  const response = await fetch("/api/auth/me").catch(() => null);
  if (response?.status === 401) {
    localStorage.removeItem(USER_KEY);
    return null;
  }
  if (!response?.ok) {
    const saved = localStorage.getItem(USER_KEY);
    return saved ? (JSON.parse(saved) as User) : null;
  }
  const user = (await response.json()) as User;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export async function signOut() {
  await request<null>("/api/auth/logout", { method: "POST" });
  localStorage.removeItem(USER_KEY);
}

/** The app has two pages, so it has no router library. */
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
