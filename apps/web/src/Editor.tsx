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
import { projectImagePath, type Project } from "@draw/shared";
import { useEffect, useRef, useState } from "react";
import { getAuthor, getProject, navigate, updateProject } from "./api.ts";
import { setupFonts } from "./fonts.ts";
import { libraryAdapter } from "./libraries.ts";
import { loadLocalImage, ProjectSync, type ImageFile, type SyncState } from "./sync.ts";

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

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export default function Editor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [sync, setSync] = useState<ProjectSync | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastKey = useRef("");
  const loadImages = useRef((_elements: readonly ExcalidrawElement[]) => {});

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
          let file = await loadLocalImage(projectId, id);
          // The editor uploads an image just before the save that uses it.
          for (let attempt = 0; !file && attempt < 5; attempt++) {
            const response = await fetch(projectImagePath(projectId, id)).catch(() => null);
            if (response?.ok) {
              const blob = await response.blob();
              file = { id, mimeType: blob.type, dataURL: await blobToDataURL(blob) };
            } else {
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
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

    const sync = new ProjectSync(projectId, getAuthor(), {
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
        thumbDue = true;
        thumbTimer ??= setTimeout(() => void saveThumb(), THUMB_EVERY_MS);
      },
    });

    let cancelled = false;
    void Promise.all([sync.load(), setupFonts()]).then(([json]) => {
      if (cancelled) return;
      const scene = json ? (JSON.parse(json) as SceneFile) : null;
      fitFirstScene = !scene;
      setInitialData({
        elements: scene ? restoreElements(scene.elements, null) : [],
        appState: { ...scene?.appState, minimapEnabled: true },
        scrollToContent: true,
      });
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
  }, [projectId]);

  if (!initialData || !sync) return <p className="page-note">Loading</p>;

  const role = syncState?.role ?? null;
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
          />
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => navigate("/")}>All projects</MainMenu.Item>
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
    </div>
  );
}

function StatusBar({
  state,
  projectName,
  onTakeOver,
}: {
  state: SyncState | null;
  projectName: string | undefined;
  onTakeOver: () => void;
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
      <span role="status" data-head={state?.head ?? ""} data-role={state?.role ?? ""}>
        {text}
      </span>
      {state?.error && <span role="alert">{state.error}</span>}
      {state?.role === "viewer" && state.status !== "offline" && (
        <button type="button" onClick={onTakeOver}>
          Take over
        </button>
      )}
    </div>
  );
}
