import { Badge, Button, Select, Switch } from "@cloudflare/kumo";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { MAIN_BRANCH, type BranchInfo, type Role, type VersionInfo } from "@draw/shared";
import {
  ArrowCounterClockwiseIcon,
  GitBranchIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listBranches, listVersions } from "./api.ts";
import { layoutGraph, type GraphRow } from "./graph.ts";
import { loadImageFile } from "./images.ts";

/** The panel shows this many versions, and "Show more" adds the same number. */
const PAGE = 100;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatTime = (time: number) => timeFormat.format(time);

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A short time for a row: "3 min. ago" today, and the date with the time before. */
function formatAgo(time: number, now: number) {
  const minutes = Math.round((time - now) / 60_000);
  if (minutes > -1) return "just now";
  if (minutes > -60) return relativeFormat.format(minutes, "minute");
  if (minutes > -12 * 60) return relativeFormat.format(Math.round(minutes / 60), "hour");
  return `${dayFormat.format(time)}, ${clockFormat.format(time)}`;
}

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

/** The content of the History sidebar: the branch selector and a graph of the versions of all branches. */
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
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let current = true;
    Promise.all([listBranches(projectId), listVersions(projectId, namedOnly, limit)]).then(
      ([nextBranches, nextVersions]) => {
        if (!current) return;
        setBranches(nextBranches);
        setVersions(nextVersions);
        setNow(Date.now());
        setError(null);
      },
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [projectId, namedOnly, limit, tick]);

  // "5 min. ago" stays true when nobody saves.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const graph = layoutGraph(versions ?? [], branches);
  return (
    <div className="history kumo-scope">
      <div className="history__branch">
        <span aria-hidden="true">Branch</span>
        <Select
          className="history__select"
          size="sm"
          aria-label="Branch"
          value={branch}
          onValueChange={(name) => name && name !== branch && actions.switchBranch(name)}
          items={Object.fromEntries(
            (branches.length ? branches.map((b) => b.name) : [branch]).map((name) => [name, name]),
          )}
        />
        {branch !== MAIN_BRANCH && (
          <>
            <Button
              size="sm"
              shape="square"
              variant="ghost"
              icon={PencilSimpleIcon}
              title="Rename this branch"
              onClick={() => actions.renameBranch(branch)}
            />
            <Button
              size="sm"
              shape="square"
              variant="ghost"
              icon={TrashIcon}
              title="Delete this branch"
              onClick={() => actions.deleteBranch(branch)}
            />
          </>
        )}
      </div>
      <Switch
        size="sm"
        label="Named versions only"
        checked={namedOnly}
        onCheckedChange={setNamedOnly}
      />
      {error && <p role="alert">{error}</p>}
      {versions?.length === 0 && (
        <p className="history__note">
          {namedOnly
            ? "No version has a name. Press Ctrl+S to name the current version."
            : "No version yet."}
        </p>
      )}
      <ol
        className="graph"
        aria-label="Versions of all branches"
        style={{ "--graph-width": `${graphWidth(graph.lanes)}px` } as CSSProperties}
      >
        {versions?.map((version, index) => {
          const isHead = version.id === headVersionId;
          const onBranch = version.branch === branch;
          const restoreBlock = !onBranch
            ? `Open the branch ${version.branch} to restore this version`
            : role !== "editor"
              ? "Take over the branch to restore a version"
              : isHead
                ? "This is the current version"
                : null;
          const row = graph.rows[index]!;
          return (
            <li
              key={version.id}
              className="commit"
              aria-current={version.id === previewId ? "true" : undefined}
              data-version-id={version.id}
              style={{ "--lane-color": laneColor(row.color) } as CSSProperties}
              // The whole row opens the preview. Keyboard users have the name button.
              onClick={(event) => {
                if (!(event.target as Element).closest("button, .commit__actions")) {
                  actions.preview(version);
                }
              }}
            >
              <GraphCell row={row} named={!!version.name} head={isHead} />
              <div className="commit__body">
                <div className="commit__title">
                  {row.branchTop && (
                    <BranchLabel
                      name={version.branch}
                      open={onBranch}
                      onOpen={() => actions.switchBranch(version.branch)}
                    />
                  )}
                  <button
                    type="button"
                    className={version.name ? "commit__name" : "commit__name commit__name--none"}
                    title="Preview this version"
                    onClick={() => actions.preview(version)}
                  >
                    {version.name || "Autosave"}
                  </button>
                  {isHead && <Badge variant="success">Current</Badge>}
                </div>
                <div className="commit__meta">
                  {version.author || "Unknown"} ·{" "}
                  <time
                    dateTime={new Date(version.updatedAt).toISOString()}
                    title={formatTime(version.updatedAt)}
                  >
                    {formatAgo(version.updatedAt, now)}
                  </time>
                </div>
              </div>
              <div className="commit__actions">
                <Button
                  size="sm"
                  shape="square"
                  variant="ghost"
                  icon={PencilSimpleIcon}
                  title={version.name ? "Rename this version" : "Name this version"}
                  onClick={() => actions.name(version)}
                />
                <Button
                  size="sm"
                  shape="square"
                  variant="ghost"
                  icon={ArrowCounterClockwiseIcon}
                  title={restoreBlock ?? "Restore this version"}
                  aria-label="Restore this version"
                  disabled={restoreBlock !== null}
                  onClick={() => actions.restore(version)}
                />
                <Button
                  size="sm"
                  shape="square"
                  variant="ghost"
                  icon={GitBranchIcon}
                  title="Create branch from this version"
                  onClick={() => actions.branch(version)}
                />
              </div>
            </li>
          );
        })}
      </ol>
      {versions?.length === limit && (
        <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE)}>
          Show more
        </Button>
      )}
    </div>
  );
}

/** Distance between lanes, the x of the first lane, and the y of the dot in a row. */
const LANE = 14;
const PAD = 10;
const DOT_Y = 20;

const LANE_COLORS = [
  "#6965db",
  "#f76707",
  "#0ca678",
  "#e64980",
  "#1c7ed6",
  "#f59f00",
  "#7048e8",
  "#74b816",
];
const laneColor = (color: number) => LANE_COLORS[color % LANE_COLORS.length]!;
const laneX = (lane: number) => PAD + lane * LANE;
const graphWidth = (lanes: number) => 2 * PAD + Math.max(lanes - 1, 0) * LANE;

/** The lines and the dot of one row. The lines reach the top and the bottom of the row. */
function GraphCell({ row, named, head }: { row: GraphRow; named: boolean; head: boolean }) {
  const x = laneX(row.lane);
  const color = laneColor(row.color);
  return (
    <svg className="commit__graph" aria-hidden="true">
      {row.through.map((other) => (
        <line
          key={other.lane}
          x1={laneX(other.lane)}
          x2={laneX(other.lane)}
          y1="0"
          y2="100%"
          stroke={laneColor(other.color)}
        />
      ))}
      {row.forks.map((fork) => {
        const fx = laneX(fork.lane);
        return (
          <path
            key={fork.lane}
            d={`M ${fx} 0 C ${fx} ${DOT_Y} ${fx} ${DOT_Y} ${x} ${DOT_Y}`}
            stroke={laneColor(fork.color)}
            fill="none"
          />
        );
      })}
      {row.lineAbove && <line x1={x} x2={x} y1="0" y2={DOT_Y} stroke={color} />}
      {row.lineBelow && <line x1={x} x2={x} y1={DOT_Y} y2="100%" stroke={color} />}
      {head && <circle cx={x} cy={DOT_Y} r="8" fill="none" stroke={color} opacity="0.35" />}
      <circle
        className={named ? "commit__dot commit__dot--named" : "commit__dot"}
        cx={x}
        cy={DOT_Y}
        r={named ? 5.5 : 4}
        stroke={color}
      />
    </svg>
  );
}

/** The name of a branch at its newest row. Another branch opens with a click. */
function BranchLabel({ name, open, onOpen }: { name: string; open: boolean; onOpen: () => void }) {
  if (open) {
    return (
      <span className="branch-label branch-label--open" title="The open branch">
        <GitBranchIcon aria-hidden="true" />
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="branch-label"
      title={`Open the branch ${name}`}
      onClick={onOpen}
    >
      <GitBranchIcon aria-hidden="true" />
      {name}
    </button>
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
