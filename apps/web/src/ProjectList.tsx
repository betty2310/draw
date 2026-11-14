import type { Project } from "@draw/shared";
import { useEffect, useState } from "react";
import { createProject, listProjects, navigate, setAuthor, updateProject } from "./api.ts";

export function ProjectList({ author }: { author: string }) {
  const [trash, setTrash] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setProjects(null);
    listProjects(trash).then(
      (list) => current && setProjects(list),
      (e: unknown) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [trash]);

  async function run(action: () => Promise<unknown>) {
    try {
      setError(null);
      await action();
      setProjects(await listProjects(trash));
    } catch (e) {
      setError(String(e));
    }
  }

  async function create() {
    const name = prompt("Project name", "Untitled");
    if (name === null) return;
    try {
      const project = await createProject(name);
      navigate(`/p/${project.id}`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>draw</h1>
        <span className="author">
          {author}{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              const name = prompt("Your name", author)?.trim();
              if (name) {
                setAuthor(name);
                location.reload();
              }
            }}
          >
            Change name
          </button>
        </span>
      </header>
      <nav className="tabs">
        <button type="button" aria-pressed={!trash} onClick={() => setTrash(false)}>
          Projects
        </button>
        <button type="button" aria-pressed={trash} onClick={() => setTrash(true)}>
          Trash
        </button>
        {!trash && (
          <button type="button" className="primary" onClick={create}>
            New project
          </button>
        )}
      </nav>
      {error && <p role="alert">{error}</p>}
      {projects === null ? (
        <p className="page-note">Loading</p>
      ) : projects.length === 0 ? (
        <p className="page-note">{trash ? "The trash is empty." : "No projects yet."}</p>
      ) : (
        <ul className="projects">
          {projects.map((project) => (
            <li key={project.id} className="project">
              <a
                href={`/p/${project.id}`}
                className="project__thumb"
                onClick={(event) => {
                  event.preventDefault();
                  if (!trash) navigate(`/p/${project.id}`);
                }}
              >
                {project.thumb ? <img src={project.thumb} alt="" /> : <span>Empty</span>}
              </a>
              <div className="project__name">{project.name}</div>
              <div className="project__time">
                Changed {new Date(project.updatedAt).toLocaleString()}
              </div>
              <div className="project__actions">
                {trash ? (
                  <button
                    type="button"
                    onClick={() => run(() => updateProject(project.id, { trashed: false }))}
                  >
                    Restore
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        const name = prompt("New name", project.name)?.trim();
                        if (name) void run(() => updateProject(project.id, { name }));
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => run(() => updateProject(project.id, { trashed: true }))}
                    >
                      Move to trash
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
