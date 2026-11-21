import { Banner, Button, DropdownMenu, Empty, LayerCard, Loader, Tabs } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  DotsThreeIcon,
  FolderOpenIcon,
  PencilSimpleLineIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { Project, User } from "@draw/shared";
import { useEffect, useState } from "react";
import { createProject, listProjects, navigate, signOut, updateProject } from "./api.ts";
import { Avatar, Brand, Mascot, SiteFooter } from "./Profile.tsx";
import { TextDialog, type TextDialogProps } from "./TextDialog.tsx";

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Infinity],
];

/** For example "5 minutes ago". */
function timeAgo(time: number) {
  let value = (time - Date.now()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return relativeTime.format(Math.round(value), unit);
    value /= size;
  }
  return "";
}

export function ProjectList({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [trash, setTrash] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TextDialogProps | null>(null);

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

  const create = () =>
    setDialog({
      title: "New project",
      label: "Project name",
      initial: "Untitled",
      note: "Only you can see and open the project.",
      submit: "Create project",
      onSubmit: async (name) => {
        const project = await createProject(name);
        navigate(`/p/${project.id}`);
      },
    });

  const rename = (project: Project) =>
    setDialog({
      title: "Rename project",
      label: "Project name",
      initial: project.name,
      submit: "Rename",
      onSubmit: async (name) => {
        await updateProject(project.id, { name });
        setProjects(await listProjects(trash));
      },
    });

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-kumo-hairline bg-kumo-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Brand />
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" aria-label="Your account">
                  <Avatar name={user.name} picture={user.picture} />
                  <span className="max-w-40 truncate">{user.name}</span>
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              <DropdownMenu.Group>
                <DropdownMenu.Label>
                  <span className="block truncate font-medium text-kumo-default">{user.name}</span>
                  <span className="block truncate font-normal text-kumo-subtle">{user.email}</span>
                </DropdownMenu.Label>
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={SignOutIcon}
                onClick={() => signOut().then(onSignedOut, (e: unknown) => setError(String(e)))}
              >
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong">
              {trash ? "Trash" : "Projects"}
            </h1>
            <p className="text-sm text-kumo-subtle">
              {trash
                ? "Restore a project to see it in the list again."
                : "Only you see these projects. Each change is saved."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Tabs
              value={trash ? "trash" : "projects"}
              onValueChange={(value) => setTrash(value === "trash")}
              tabs={[
                { value: "projects", label: "Projects" },
                { value: "trash", label: "Trash" },
              ]}
            />
            <Button variant="primary" icon={PlusIcon} onClick={create}>
              New project
            </Button>
          </div>
        </div>

        {error && (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="Something did not work"
            description={error}
          />
        )}

        {projects === null ? (
          <div className="grid place-items-center py-24 text-kumo-subtle" aria-label="Loading">
            <Loader size={24} />
          </div>
        ) : projects.length === 0 ? (
          <LayerCard className="py-16">
            {trash ? (
              <Empty
                icon={<TrashIcon size={48} className="text-kumo-inactive" />}
                title="The trash is empty"
                description="Projects that you move to the trash show here."
              />
            ) : (
              <Empty
                icon={<FolderOpenIcon size={48} className="text-kumo-inactive" />}
                title="No projects yet"
                description="Create a project to start a drawing."
                contents={
                  <Button variant="primary" icon={PlusIcon} onClick={create}>
                    New project
                  </Button>
                }
              />
            )}
          </LayerCard>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-5">
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard
                  project={project}
                  trash={trash}
                  onRename={() => rename(project)}
                  onTrash={() => run(() => updateProject(project.id, { trashed: true }))}
                  onRestore={() => run(() => updateProject(project.id, { trashed: false }))}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      <SiteFooter />
      {dialog && <TextDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ProjectCard({
  project,
  trash,
  onRename,
  onTrash,
  onRestore,
}: {
  project: Project;
  trash: boolean;
  onRename: () => void;
  onTrash: () => void;
  onRestore: () => void;
}) {
  const href = `/p/${project.id}`;
  return (
    <LayerCard className="group h-full transition-shadow hover:shadow-md">
      <a
        href={href}
        aria-label={trash ? undefined : `Open ${project.name}`}
        tabIndex={trash ? -1 : undefined}
        className={
          "relative grid aspect-[16/10] place-items-center overflow-hidden border-b border-kumo-hairline bg-white" +
          (trash ? " pointer-events-none opacity-60" : "")
        }
        onClick={(event) => {
          event.preventDefault();
          if (!trash) navigate(href);
        }}
      >
        {project.thumb ? (
          <img
            src={project.thumb}
            alt=""
            className="absolute inset-0 size-full object-contain p-4 transition-transform duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <Mascot className="h-14 w-auto opacity-25 grayscale" />
        )}
      </a>
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-kumo-default" title={project.name}>
            {project.name}
          </span>
          <span
            className="truncate text-xs text-kumo-subtle"
            title={new Date(project.updatedAt).toLocaleString()}
          >
            {trash && project.deletedAt
              ? `Moved to the trash ${timeAgo(project.deletedAt)}`
              : `Changed ${timeAgo(project.updatedAt)}`}
          </span>
        </div>
        {trash ? (
          <Button size="sm" icon={ArrowCounterClockwiseIcon} onClick={onRestore}>
            Restore
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<DotsThreeIcon size={20} weight="bold" />}
                  aria-label={`Actions for ${project.name}`}
                />
              }
            />
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item icon={PencilSimpleLineIcon} onClick={onRename}>
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={onTrash}>
                Move to trash
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </div>
    </LayerCard>
  );
}
