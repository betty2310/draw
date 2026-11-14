import type { BranchInfo, VersionInfo } from "@draw/shared";

/** A lane of the graph with the color of its branch. */
export interface LaneRef {
  lane: number;
  color: number;
}

/** What the graph draws in the row of one version. */
export interface GraphRow extends LaneRef {
  /** The branch has a newer version in a row above. */
  lineAbove: boolean;
  /** The branch continues below: to an older version, or to the version it starts from. */
  lineBelow: boolean;
  /** The first row of the branch in the list, where its label shows. */
  branchTop: boolean;
  /** Other branches that pass this row. */
  through: LaneRef[];
  /** Branches that start from this version. Each one curves from its lane into the dot. */
  forks: LaneRef[];
}

export interface Graph {
  rows: GraphRow[];
  /** The number of lanes, for the width of the graph. */
  lanes: number;
}

/**
 * Puts the versions of all branches, newest first, into lanes like a git graph. Each branch has
 * one lane from its first row in the list to the version it starts from. When that version is not
 * in the list (for example with "Named versions only"), the branch starts from the nearest older
 * version of its parent branch in the list.
 */
export function layoutGraph(versions: VersionInfo[], branches: BranchInfo[]): Graph {
  // The color of a branch does not change with the filter: it is the place of the branch in the
  // branch list, where main is first and the other branches follow in order of creation.
  const order = branches.map((b) => b.name);
  for (const v of versions) if (!order.includes(v.branch)) order.push(v.branch);

  const spans = new Map<
    string,
    { top: number; last: number; end: number; forkRow: number | null }
  >();
  versions.forEach((v, row) => {
    const span = spans.get(v.branch);
    if (span) span.last = row;
    else spans.set(v.branch, { top: row, last: row, end: row, forkRow: null });
  });
  for (const [name, span] of spans) {
    const info = branches.find((b) => b.name === name);
    if (info?.fromVersionId == null || info.fromBranch === null) continue;
    const from = info.fromVersionId;
    const forkRow = versions.findIndex(
      (v, row) => row > span.last && v.branch === info.fromBranch && v.id <= from,
    );
    if (forkRow !== -1) span.forkRow = forkRow;
  }

  // Each lane keeps the row ranges of its branches. A branch takes the first lane that is free
  // from its first row to its end row, both included.
  const used: Array<Array<[number, number]>> = [];
  const lanes = new Map<string, LaneRef>();
  for (const name of order) {
    const span = spans.get(name);
    if (!span) continue;
    span.end = span.forkRow ?? span.last;
    let lane = used.findIndex((ranges) =>
      ranges.every(([top, end]) => end < span.top || top > span.end),
    );
    if (lane === -1) lane = used.push([]) - 1;
    used[lane]!.push([span.top, span.end]);
    lanes.set(name, { lane, color: order.indexOf(name) });
  }

  const rows = versions.map((v, row): GraphRow => {
    const span = spans.get(v.branch)!;
    const through: LaneRef[] = [];
    const forks: LaneRef[] = [];
    for (const name of order) {
      const other = spans.get(name);
      if (!other || name === v.branch) continue;
      if (other.top < row && row < other.end) through.push(lanes.get(name)!);
      else if (other.forkRow === row) forks.push(lanes.get(name)!);
    }
    return {
      ...lanes.get(v.branch)!,
      lineAbove: row > span.top,
      lineBelow: row < span.end,
      branchTop: row === span.top,
      through,
      forks,
    };
  });
  return { rows, lanes: used.length };
}
