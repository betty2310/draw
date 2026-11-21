import { Loader } from "@cloudflare/kumo";
import { MAIN_BRANCH, type User } from "@draw/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { getMe, SIGNED_OUT_EVENT } from "./api.ts";
import { WelcomePage } from "./Profile.tsx";
import { ProjectList } from "./ProjectList.tsx";

// The editor is large, so the project list loads without it.
const Editor = lazy(() => import("./Editor.tsx"));

const projectIdFromPath = (path: string) => /^\/p\/([\w-]+)$/.exec(path)?.[1] ?? null;

export function App() {
  const [path, setPath] = useState(location.pathname);
  // The branch is in the query, so a switch of branch opens a new editor.
  const [search, setSearch] = useState(location.search);
  /** Undefined while the app asks the server. */
  const [user, setUser] = useState<User | null>();

  useEffect(() => {
    void getMe().then(setUser);
    const onSignedOut = () => setUser(null);
    const onPopState = () => {
      setPath(location.pathname);
      setSearch(location.search);
    };
    addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    addEventListener("popstate", onPopState);
    return () => {
      removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
      removeEventListener("popstate", onPopState);
    };
  }, []);

  if (user === undefined) return <PageLoader />;
  if (user === null) {
    const signInFailed = new URLSearchParams(search).get("signin") === "failed";
    return <WelcomePage next={path === "/" ? "/" : path + search} failed={signInFailed} />;
  }

  const projectId = projectIdFromPath(path);
  if (projectId) {
    const branch = new URLSearchParams(search).get("branch") || MAIN_BRANCH;
    return (
      <Suspense fallback={<PageLoader />}>
        <Editor key={`${projectId}:${branch}`} projectId={projectId} branch={branch} />
      </Suspense>
    );
  }
  return <ProjectList user={user} onSignedOut={() => setUser(null)} />;
}

function PageLoader() {
  return (
    <div className="grid min-h-screen place-items-center text-kumo-subtle" aria-label="Loading">
      <Loader size={24} />
    </div>
  );
}
