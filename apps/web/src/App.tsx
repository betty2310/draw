import { Loader } from "@cloudflare/kumo";
import { MAIN_BRANCH } from "@draw/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { loadProfile, saveProfile, WelcomePage, type Profile } from "./Profile.tsx";
import { ProjectList } from "./ProjectList.tsx";

// The editor is large, so the project list loads without it.
const Editor = lazy(() => import("./Editor.tsx"));

const projectIdFromPath = (path: string) => /^\/p\/([\w-]+)$/.exec(path)?.[1] ?? null;

export function App() {
  const [path, setPath] = useState(location.pathname);
  // The branch is in the query, so a switch of branch opens a new editor.
  const [search, setSearch] = useState(location.search);
  const [profile, setProfile] = useState(loadProfile);
  const changeProfile = (next: Profile) => {
    saveProfile(next);
    setProfile(next);
  };

  useEffect(() => {
    const onPopState = () => {
      setPath(location.pathname);
      setSearch(location.search);
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  if (!profile.name) return <WelcomePage onDone={changeProfile} />;

  const projectId = projectIdFromPath(path);
  if (projectId) {
    const branch = new URLSearchParams(search).get("branch") || MAIN_BRANCH;
    return (
      <Suspense fallback={<PageLoader />}>
        <Editor key={`${projectId}:${branch}`} projectId={projectId} branch={branch} />
      </Suspense>
    );
  }
  return <ProjectList profile={profile} onProfileChange={changeProfile} />;
}

function PageLoader() {
  return (
    <div className="grid min-h-screen place-items-center text-kumo-subtle" aria-label="Loading">
      <Loader size={24} />
    </div>
  );
}
