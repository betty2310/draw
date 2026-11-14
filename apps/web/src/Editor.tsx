import {
  CaptureUpdateAction,
  Excalidraw,
  exportScene,
  getNonDeletedElements,
  hashElementsVersion,
  MainMenu,
  reconcileElements,
  restoreElements,
  serializeAsJSON,
  Sidebar,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { MAIN_BRANCH, type Project, type VersionInfo } from "@draw/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBranch,
  deleteBranch,
  editorPath,
  getAuthor,
  getProject,
  getVersionScene,
  navigate,
  nameVersion,
  renameBranch,
  updateProject,
} from "./api.ts";
import { setupFonts } from "./fonts.ts";
import { HistoryPanel, VersionPreview, versionLabel, type HistoryActions } from "./History.tsx";
import { blobToDataURL, loadImageFile } from "./images.ts";
import { libraryAdapter } from "./libraries.ts";
import { ProjectSync, type ImageFile, type SyncState } from "./sync.ts";
import { TextDialog, type TextDialogProps } from "./TextDialog.tsx";

const HISTORY_SIDEBAR = "history";

/** A switch of branch opens a new editor. The History sidebar stays open after it. */
let reopenHistory = false;
/** A message for the next editor, for example that its branch was deleted. */
let nextNotice: string | null = null;
/** The branch that this page deletes. Its own delete needs no notice. */
let deletingBranch: string | null = null;
const openBranch = (projectId: string, branch: string) => {
  reopenHistory = true;
  navigate(editorPath(projectId, branch));
};

/** The project list shows a thumbnail. It is made at most this often while you draw. */
const THUMB_EVERY_MS = 10_000;

interface SceneFile {
  elements: ExcalidrawElement[];
  appState?: Partial<AppState>;
}

/** Changes when the scene changes, but not when only the selection or the view changes. */
const sceneKey = (
  elements: readonly ExcalidrawElement[],
  background: string | undefined,
  files: BinaryFiles,
) => `${hashElementsVersion(elements)}|${background}|${Object.keys(files).length}`;

// Deleted elements stay in the scene, so a merge of two copies does not bring them back.
const serialize = (api: ExcalidrawImperativeAPI) =>
  serializeAsJSON(api.getSceneElementsIncludingDeleted(), api.getAppState(), {}, "database");

const imageFiles = (api: ExcalidrawImperativeAPI): ImageFile[] =>
  Object.values(api.getFiles()).map(({ id, mimeType, dataURL }) => ({ id, mimeType, dataURL }));

export default function Editor({ projectId, branch }: { projectId: string; branch: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [sync, setSync] = useState<ProjectSync | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastKey = useRef("");
  const loadImages = useRef((_elements: readonly ExcalidrawElement[]) => {});
  const [historyTick, setHistoryTick] = useState(0);
  const [preview, setPreview] = useState<{ version: VersionInfo; json: string } | null>(null);
  const [dialog, setDialog] = useState<TextDialogProps | null>(null);
  const [sidebarDocked, setSidebarDocked] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState(() => {
    const text = nextNotice;
    nextNotice = null;
    return text;
  });

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });

  useEffect(() => {
    getProject(projectId).then(setProject, () => setProject(null));
  }, [projectId]);

  useEffect(() => {
    let thumbTimer: ReturnType<typeof setTimeout> | undefined;
    let thumbDue = false;
    let fitFirstScene = false;
    const loadingImages = new Set<string>();

    const saveThumb = async () => {
      thumbTimer = undefined;
      thumbDue = false;
      const api = apiRef.current;
      if (!api) return;
      const elements = getNonDeletedElements(api.getSceneElements());
      const thumb =
        elements.length === 0
          ? ""
          : await blobToDataURL(
              await exportScene({
                type: "png",
                data: { elements, files: api.getFiles() },
                config: {
                  maxWidthOrHeight: 320,
                  canvasBackgroundColor: api.getAppState().viewBackgroundColor,
                },
              }),
            );
      await updateProject(projectId, { thumb }).catch(() => {});
    };

    /** Images of a scene from the server come from this browser or from the server. */
    const loadMissingImages = async (elements: readonly ExcalidrawElement[]) => {
      const api = apiRef.current!;
      const have = api.getFiles();
      for (const element of elements) {
        if (element.type !== "image" || !element.fileId || element.isDeleted) continue;
        const id = element.fileId;
        if (have[id] || loadingImages.has(id)) continue;
        loadingImages.add(id);
        void (async () => {
          const file = await loadImageFile(projectId, id, 5);
          loadingImages.delete(id);
          if (file && !apiRef.current?.isDestroyed) {
            apiRef.current!.addFiles([
              {
                id: file.id as FileId,
                mimeType: file.mimeType as never,
                dataURL: file.dataURL as never,
                created: Date.now(),
              },
            ]);
          }
        })();
      }
    };

    const sync = new ProjectSync(projectId, branch, getAuthor(), {
      serialize: () => serialize(apiRef.current!),
      files: () => imageFiles(apiRef.current!),
      applyRemote(json, merge) {
        const api = apiRef.current!;
        const scene = JSON.parse(json) as SceneFile;
        const remote = restoreElements(scene.elements, null);
        const elements = merge
          ? reconcileElements(
              api.getSceneElementsIncludingDeleted(),
              remote as RemoteExcalidrawElement[],
              api.getAppState(),
            )
          : remote;
        const background = scene.appState?.viewBackgroundColor;
        api.updateScene({
          elements,
          appState: background ? { viewBackgroundColor: background } : null,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // A scene from the server is not a local change. A merge is, and the sync saves it.
        if (!merge) {
          lastKey.current = sceneKey(
            elements,
            background ?? api.getAppState().viewBackgroundColor,
            api.getFiles(),
          );
        }
        void loadMissingImages(elements);
        const visible = getNonDeletedElements(elements);
        if (fitFirstScene && visible.length > 0) {
          fitFirstScene = false;
          api.setViewport({ target: visible, fit: "scale-down" });
        }
      },
      onState: setSyncState,
      onSaved() {
        // The project list shows the drawing of main.
        if (sync.state.branch !== MAIN_BRANCH) return;
        thumbDue = true;
        thumbTimer ??= setTimeout(() => void saveThumb(), THUMB_EVERY_MS);
      },
      onHistory: () => setHistoryTick((tick) => tick + 1),
      onBranchGone() {
        if (deletingBranch !== sync.state.branch) {
          nextNotice = `The branch "${sync.state.branch}" was deleted. This is the main branch.`;
        }
        history.replaceState(null, "", editorPath(projectId, MAIN_BRANCH));
        dispatchEvent(new PopStateEvent("popstate"));
      },
    });

    let cancelled = false;
    void Promise.all([sync.load(), setupFonts()]).then(([json]) => {
      if (cancelled) return;
      const scene = json ? (JSON.parse(json) as SceneFile) : null;
      fitFirstScene = !scene;
      setInitialData({
        elements: scene ? restoreElements(scene.elements, null) : [],
        appState: {
          ...scene?.appState,
          minimapEnabled: true,
          openSidebar: reopenHistory ? { name: HISTORY_SIDEBAR } : null,
        },
        scrollToContent: true,
      });
      reopenHistory = false;
      loadImages.current = (elements) => void loadMissingImages(elements);
      // The editor calls `connect` when it shows the local copy (see onInitialize).
      setSync(sync);
    });

    return () => {
      cancelled = true;
      sync.stop();
      clearTimeout(thumbTimer);
      if (thumbDue) void saveThumb();
    };
  }, [projectId, branch]);

  // A rename of the branch keeps this page and changes the URL.
  const currentBranch = syncState?.branch ?? branch;
  useEffect(() => {
    if (currentBranch !== branch) {
      history.replaceState(null, "", editorPath(projectId, currentBranch));
    }
  }, [projectId, branch, currentBranch]);

  /** Names the current version. The local changes are saved first, so the name includes them. */
  const nameCurrentVersion = useCallback(() => {
    if (!sync) return;
    setDialog({
      title: "Name this version",
      label: "Name",
      note: "A version with a name is kept. Versions with no name are deleted after 30 days.",
      submit: "Save name",
      onSubmit: async (name) => {
        await sync.flush();
        const id = sync.state.headVersionId;
        if (id === null) throw new Error("Draw something first. The branch has no version.");
        await nameVersion(projectId, id, name);
      },
    });
  }, [projectId, sync]);

  // Ctrl+S names the current version. Excalidraw would save a file instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "s") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!dialog) nameCurrentVersion();
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  }, [dialog, nameCurrentVersion]);

  if (!initialData || !sync) return <p className="page-note">Loading</p>;

  const role = syncState?.role ?? null;
  const headVersionId = syncState?.headVersionId ?? null;

  const restore = (version: VersionInfo) =>
    setDialog({
      title: "Restore this version?",
      note: `A new version on ${currentBranch} gets the drawing of "${versionLabel(version)}". No version is removed.`,
      submit: "Restore",
      onSubmit: async () => {
        sync.restore(version.id);
        setPreview(null);
      },
    });

  const branchFrom = (version: VersionInfo) =>
    setDialog({
      title: "Create branch from this version",
      label: "Branch name",
      note: `The new branch starts with the drawing of "${versionLabel(version)}".`,
      submit: "Create branch",
      onSubmit: async (name) => {
        // A branch from the current version includes the changes of the last seconds.
        if (version.id === headVersionId) await sync.flush();
        const created = await createBranch(projectId, name, version.id);
        openBranch(projectId, created.name);
      },
    });

  const actions: HistoryActions = {
    async preview(version) {
      if (preview?.version.id === version.id) return setPreview(null);
      try {
        setPreview({ version, json: await getVersionScene(projectId, version.id) });
      } catch (reason) {
        alert(reason instanceof Error ? reason.message : String(reason));
      }
    },
    name: (version) =>
      setDialog({
        title: version.name ? "Rename this version" : "Name this version",
        label: "Name",
        initial: version.name,
        note: "Leave the name empty to remove it. Versions with no name are deleted after 30 days.",
        submit: "Save name",
        allowEmpty: !!version.name,
        onSubmit: async (name) => void (await nameVersion(projectId, version.id, name)),
      }),
    restore,
    branch: branchFrom,
    switchBranch: (name) => openBranch(projectId, name),
    renameBranch: (name) =>
      setDialog({
        title: "Rename branch",
        label: "Branch name",
        initial: name,
        submit: "Rename",
        onSubmit: async (to) => void (await renameBranch(projectId, name, to)),
      }),
    deleteBranch: (name) =>
      setDialog({
        title: `Delete the branch "${name}"?`,
        note: "All versions of the branch are deleted, also the versions with a name. Other branches do not change.",
        submit: "Delete branch",
        danger: true,
        onSubmit: async () => {
          deletingBranch = name;
          // The notice of the server can open main before this page does.
          reopenHistory = true;
          try {
            await deleteBranch(projectId, name);
          } finally {
            deletingBranch = null;
          }
          openBranch(projectId, MAIN_BRANCH);
        },
      }),
  };
  return (
    <div className="editor">
      <Excalidraw
        initialData={initialData}
        name={project?.name}
        viewModeEnabled={role !== "editor"}
        onExcalidrawAPI={(next) => {
          apiRef.current = next;
          setApi(next);
        }}
        onInitialize={(api) => {
          lastKey.current = sceneKey(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState().viewBackgroundColor,
            api.getFiles(),
          );
          loadImages.current(api.getSceneElementsIncludingDeleted());
          sync.connect();
        }}
        onChange={(elements, appState, files) => {
          const key = sceneKey(elements, appState.viewBackgroundColor, files);
          if (key === lastKey.current) return;
          lastKey.current = key;
          sync.changed();
        }}
        renderTopRightUI={() => (
          <StatusBar
            state={syncState}
            projectName={project?.name}
            onTakeOver={() => sync.takeOver()}
            // The sidebar has its own close button, and the bar has less room beside it.
            onHistory={historyOpen ? null : () => api?.toggleSidebar({ name: HISTORY_SIDEBAR })}
            notice={notice}
            onCloseNotice={() => setNotice(null)}
          />
        )}
      >
        <Sidebar
          name={HISTORY_SIDEBAR}
          docked={sidebarDocked}
          onDock={setSidebarDocked}
          onStateChange={(state) => setHistoryOpen(state?.name === HISTORY_SIDEBAR)}
        >
          <Sidebar.Header>History</Sidebar.Header>
          <HistoryPanel
            projectId={projectId}
            branch={currentBranch}
            role={role}
            headVersionId={headVersionId}
            previewId={preview?.version.id ?? null}
            tick={historyTick}
            actions={actions}
          />
        </Sidebar>
        <MainMenu>
          <MainMenu.Item onSelect={() => navigate("/")}>All projects</MainMenu.Item>
          <MainMenu.Item
            onSelect={() => api?.toggleSidebar({ name: HISTORY_SIDEBAR, force: true })}
          >
            Version history
          </MainMenu.Item>
          <MainMenu.Item onSelect={nameCurrentVersion} shortcut="Ctrl+S">
            Name this version
          </MainMenu.Item>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {preview && (
        <VersionPreview
          key={preview.version.id}
          besideSidebar={historyOpen && sidebarDocked}
          projectId={projectId}
          version={preview.version}
          json={preview.json}
          // The History panel also previews versions of other branches. A restore stays in a branch.
          canRestore={
            role === "editor" &&
            preview.version.branch === currentBranch &&
            preview.version.id !== headVersionId
          }
          onRestore={() => restore(preview.version)}
          onBranch={() => branchFrom(preview.version)}
          onClose={() => setPreview(null)}
        />
      )}
      {dialog && <TextDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function StatusBar({
  state,
  projectName,
  onTakeOver,
  onHistory,
  notice,
  onCloseNotice,
}: {
  state: SyncState | null;
  projectName: string | undefined;
  onTakeOver: () => void;
  onHistory: (() => void) | null;
  notice: string | null;
  onCloseNotice: () => void;
}) {
  let text: string;
  if (!state || state.role === null) text = "Connecting";
  else if (state.status === "offline") text = "Offline, saved in this browser";
  else if (state.role === "viewer") text = `Read-only. ${state.editor ?? "Nobody"} edits.`;
  else text = state.status === "saving" ? "Saving" : "Saved";
  return (
    <div className="status-bar">
      <a
        href="/"
        onClick={(event) => {
          event.preventDefault();
          navigate("/");
        }}
      >
        Projects
      </a>
      {projectName && <span className="status-bar__name">{projectName}</span>}
      {state && (
        <span className="status-bar__branch" title="Branch">
          ⑂ {state.branch}
        </span>
      )}
      <span role="status" data-head={state?.head ?? ""} data-role={state?.role ?? ""}>
        {text}
      </span>
      {state?.error && <span role="alert">{state.error}</span>}
      {notice && (
        <span role="alert">
          {notice}{" "}
          <button type="button" className="link" onClick={onCloseNotice}>
            OK
          </button>
        </span>
      )}
      {state?.role === "viewer" && state.status !== "offline" && (
        <button type="button" onClick={onTakeOver}>
          Take over
        </button>
      )}
      {onHistory && (
        <button type="button" onClick={onHistory}>
          History
        </button>
      )}
    </div>
  );
}
