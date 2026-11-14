import {
  branchPath,
  gunzip,
  MAIN_BRANCH,
  versionPath,
  type BranchInfo,
  type Project,
  type ProjectPatch,
  type VersionInfo,
} from "@draw/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
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
    body: JSON.stringify({ name, fromVersionId, author: getAuthor() }),
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

/** The name that the person typed at the first visit. It is the author of each version. */
const AUTHOR_KEY = "draw.author";
export const getAuthor = () => localStorage.getItem(AUTHOR_KEY) ?? "";
export const setAuthor = (name: string) => localStorage.setItem(AUTHOR_KEY, name);

/** The app has two pages, so it has no router library. */
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
