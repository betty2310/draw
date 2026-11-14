import type { Project, ProjectPatch } from "@draw/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const listProjects = (trash: boolean) =>
  request<Project[]>(`/api/projects${trash ? "?trash=1" : ""}`);

export const getProject = (id: string) => request<Project>(`/api/projects/${id}`);

export const createProject = (name: string) =>
  request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });

export const updateProject = (id: string, patch: ProjectPatch) =>
  request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

/** The name that the person typed at the first visit. It is the author of each version. */
const AUTHOR_KEY = "draw.author";
export const getAuthor = () => localStorage.getItem(AUTHOR_KEY) ?? "";
export const setAuthor = (name: string) => localStorage.setItem(AUTHOR_KEY, name);

/** The app has two pages, so it has no router library. */
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
