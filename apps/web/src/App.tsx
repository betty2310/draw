import { lazy, Suspense, useEffect, useState } from "react";
import { getAuthor, setAuthor } from "./api.ts";
import { ProjectList } from "./ProjectList.tsx";

// The editor is large, so the project list loads without it.
const Editor = lazy(() => import("./Editor.tsx"));

const projectIdFromPath = (path: string) => /^\/p\/([\w-]+)$/.exec(path)?.[1] ?? null;

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [author, setAuthorState] = useState(getAuthor());

  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  if (!author) {
    return (
      <NamePrompt
        onDone={(name) => {
          setAuthor(name);
          setAuthorState(name);
        }}
      />
    );
  }

  const projectId = projectIdFromPath(path);
  if (projectId) {
    return (
      <Suspense fallback={<p className="page-note">Loading</p>}>
        <Editor key={projectId} projectId={projectId} />
      </Suspense>
    );
  }
  return <ProjectList author={author} />;
}

function NamePrompt({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <main className="page">
      <h1>draw</h1>
      <form
        className="name-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onDone(name.trim());
        }}
      >
        <label htmlFor="author">Your name</label>
        <p>Each version that you save shows this name. This browser keeps it.</p>
        <input
          id="author"
          value={name}
          maxLength={100}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          Continue
        </button>
      </form>
    </main>
  );
}
