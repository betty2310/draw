import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { MAIN_BRANCH, type BranchInfo, type Role, type VersionInfo } from "@draw/shared";
import { useEffect, useRef, useState } from "react";
import { listBranches, listVersions } from "./api.ts";
import { loadImageFile } from "./images.ts";

/** The panel shows this many versions, and "Show more" adds the same number. */
const PAGE = 100;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatTime = (time: number) => timeFormat.format(time);

export const versionLabel = (version: VersionInfo) =>
  version.name || `Version of ${formatTime(version.updatedAt)}`;

export interface HistoryActions {
  preview: (version: VersionInfo) => void;
  name: (version: VersionInfo) => void;
  restore: (version: VersionInfo) => void;
  branch: (version: VersionInfo) => void;
  switchBranch: (name: string) => void;
  renameBranch: (name: string) => void;
  deleteBranch: (name: string) => void;
}

/** The content of the History sidebar: the branch selector and the versions of the branch. */
export function HistoryPanel({
  projectId,
  branch,
  role,
  headVersionId,
  previewId,
  tick,
  actions,
}: {
  projectId: string;
  branch: string;
  role: Role | null;
  headVersionId: number | null;
  previewId: number | null;
  /** Changes when the server tells that the lists changed. */
  tick: number;
  actions: HistoryActions;
}) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [namedOnly, setNamedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all([listBranches(projectId), listVersions(projectId, branch, namedOnly, limit)]).then(
      ([nextBranches, nextVersions]) => {
        if (!current) return;
        setBranches(nextBranches);
        setVersions(nextVersions);
        setError(null);
      },
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [projectId, branch, namedOnly, limit, tick]);

  const info = branches.find((b) => b.name === branch);
  return (
    <div className="history">
      <div className="history__branch">
        <label htmlFor="branch-select">Branch</label>
        <select
          id="branch-select"
          value={branch}
          onChange={(event) => actions.switchBranch(event.target.value)}
        >
          {branches.length === 0 && <option value={branch}>{branch}</option>}
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        {branch !== MAIN_BRANCH && (
          <>
            <button type="button" onClick={() => actions.renameBranch(branch)}>
              Rename
            </button>
            <button type="button" className="danger" onClick={() => actions.deleteBranch(branch)}>
              Delete
            </button>
          </>
        )}
      </div>
      {info?.fromBranch && (
        <p className="history__note">Created from a version of {info.fromBranch}</p>
      )}
      <label className="history__filter">
        <input
          type="checkbox"
          checked={namedOnly}
          onChange={(event) => setNamedOnly(event.target.checked)}
        />
        Named versions only
      </label>
      {error && <p role="alert">{error}</p>}
      {versions?.length === 0 && (
        <p className="history__note">
          {namedOnly
            ? "No version has a name. Press Ctrl+S to name the current version."
            : "No version yet."}
        </p>
      )}
      <ol className="history__list" aria-label="Versions">
        {versions?.map((version) => (
          <li
            key={version.id}
            className="version"
            aria-current={version.id === previewId ? "true" : undefined}
            data-version-id={version.id}
          >
            <button
              type="button"
              className="version__main"
              title="Preview this version"
              onClick={() => actions.preview(version)}
            >
              <span
                className={version.name ? "version__name" : "version__name version__name--none"}
              >
                {version.name || "No name"}
              </span>
              {version.id === headVersionId && <span className="tag">Current</span>}
              {version.branches.map((name) => (
                <span key={name} className="tag tag--branch" title={`Branch ${name} starts here`}>
                  ⑂ {name}
                </span>
              ))}
              <span className="version__meta">
                {version.author || "Unknown"} · {formatTime(version.updatedAt)}
              </span>
            </button>
            <div className="version__actions">
              <button type="button" onClick={() => actions.name(version)}>
                {version.name ? "Rename" : "Name"}
              </button>
              <button
                type="button"
                disabled={role !== "editor" || version.id === headVersionId}
                title={
                  role !== "editor"
                    ? "Take over the branch to restore a version"
                    : version.id === headVersionId
                      ? "This is the current version"
                      : "Restore this version"
                }
                onClick={() => actions.restore(version)}
              >
                Restore
              </button>
              <button type="button" onClick={() => actions.branch(version)}>
                Branch
              </button>
            </div>
          </li>
        ))}
      </ol>
      {versions?.length === limit && (
        <button type="button" className="link" onClick={() => setLimit(limit + PAGE)}>
          Show more
        </button>
      )}
    </div>
  );
}

interface SceneFile {
  elements: ExcalidrawElement[];
  appState?: { viewBackgroundColor?: string };
}

/** A read-only editor over the canvas that shows one version. */
export function VersionPreview({
  besideSidebar,
  projectId,
  version,
  json,
  canRestore,
  onRestore,
  onBranch,
  onClose,
}: {
  /** The docked History sidebar stays visible at the right. */
  besideSidebar: boolean;
  projectId: string;
  version: VersionInfo;
  json: string;
  canRestore: boolean;
  onRestore: () => void;
  onBranch: () => void;
  onClose: () => void;
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [scene] = useState(() => JSON.parse(json) as SceneFile);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={besideSidebar ? "preview preview--beside-sidebar" : "preview"}
      role="region"
      aria-label="Version preview"
    >
      <div className="preview__bar">
        <span>
          <strong>{versionLabel(version)}</strong> by {version.author || "Unknown"}. Read-only
          preview.
        </span>
        <button
          type="button"
          className="primary"
          disabled={!canRestore}
          title={canRestore ? undefined : "Take over the branch to restore a version"}
          onClick={onRestore}
        >
          Restore this version
        </button>
        <button type="button" onClick={onBranch}>
          Create branch from this version
        </button>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
      </div>
      <div className="preview__canvas">
        <Excalidraw
          viewModeEnabled
          initialData={{
            elements: restoreElements(scene.elements, null),
            appState: {
              viewBackgroundColor: scene.appState?.viewBackgroundColor,
              minimapEnabled: true,
            },
            scrollToContent: true,
          }}
          onExcalidrawAPI={(api) => (apiRef.current = api)}
          onInitialize={(api) => {
            for (const element of scene.elements) {
              if (element.type !== "image" || !element.fileId || element.isDeleted) continue;
              void loadImageFile(projectId, element.fileId).then((file) => {
                if (!file || api.isDestroyed) return;
                api.addFiles([
                  {
                    id: file.id as FileId,
                    mimeType: file.mimeType as never,
                    dataURL: file.dataURL as never,
                    created: Date.now(),
                  },
                ]);
              });
            }
          }}
          UIOptions={{
            canvasActions: { loadScene: false, export: false, saveToActiveFile: false },
          }}
        />
      </div>
    </div>
  );
}
