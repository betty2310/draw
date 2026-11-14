import type { BranchInfo, VersionInfo } from "@draw/shared";
import { expect, test } from "vite-plus/test";
import { layoutGraph } from "../src/graph.ts";

const version = (id: number, branch: string, name = ""): VersionInfo => ({
  id,
  branch,
  name,
  author: "An",
  createdAt: id,
  updatedAt: id,
  branches: [],
});

const branch = (name: string, fromVersionId: number | null, fromBranch: string | null) =>
  ({ name, fromVersionId, fromBranch, createdAt: 0, updatedAt: 0 }) satisfies BranchInfo;

// main: 1, 2, 4. idea starts from 1: 3, 5. alt starts from 3 (on idea): 6.
const branches = [branch("main", null, null), branch("idea", 1, "main"), branch("alt", 3, "idea")];
const all = [
  version(6, "alt"),
  version(5, "idea"),
  version(4, "main"),
  version(3, "idea"),
  version(2, "main", "Named"),
  version(1, "main"),
];

test("each branch has a lane from its newest version to the version it starts from", () => {
  const { rows, lanes } = layoutGraph(all, branches);
  expect(lanes).toBe(3);
  const lane = (n: number, color = n) => ({ lane: n, color });
  expect(rows).toEqual([
    // alt cannot use lane 0 or 1: main and idea pass its rows.
    { ...lane(2), lineAbove: false, lineBelow: true, branchTop: true, through: [], forks: [] },
    {
      ...lane(1),
      lineAbove: false,
      lineBelow: true,
      branchTop: true,
      through: [lane(2)],
      forks: [],
    },
    {
      ...lane(0),
      lineAbove: false,
      lineBelow: true,
      branchTop: true,
      through: [lane(1), lane(2)],
      forks: [],
    },
    // alt joins version 3 of idea, and main passes.
    {
      ...lane(1),
      lineAbove: true,
      lineBelow: true,
      branchTop: false,
      through: [lane(0)],
      forks: [lane(2)],
    },
    {
      ...lane(0),
      lineAbove: true,
      lineBelow: true,
      branchTop: false,
      through: [lane(1)],
      forks: [],
    },
    // idea joins version 1 of main, the last row.
    {
      ...lane(0),
      lineAbove: true,
      lineBelow: false,
      branchTop: false,
      through: [],
      forks: [lane(1)],
    },
  ]);
});

test("a lane is free again below the version where its branch starts", () => {
  // main: 1, 3. b1 starts from 3: 4. b2 starts from 1: 2. b2 ends at row 3, after b1 ends at row 1.
  const { rows, lanes } = layoutGraph(
    [version(4, "b1"), version(3, "main"), version(2, "b2"), version(1, "main")],
    [branch("main", null, null), branch("b1", 3, "main"), branch("b2", 1, "main")],
  );
  expect(lanes).toBe(2);
  expect(rows.map((r) => [r.lane, r.color])).toEqual([
    [1, 1],
    [0, 0],
    [1, 2],
    [0, 0],
  ]);
  expect(rows[1]!.forks).toEqual([{ lane: 1, color: 1 }]);
  expect(rows[3]!.forks).toEqual([{ lane: 1, color: 2 }]);
});

test("with a filter, a branch whose start version is hidden has no fork, and keeps its color", () => {
  const { rows, lanes } = layoutGraph([version(5, "idea", "Idea"), all[4]!], branches);
  expect(lanes).toBe(1);
  expect(rows[0]).toMatchObject({ lane: 0, color: 1, lineBelow: false, branchTop: true });
  expect(rows[1]).toMatchObject({ lane: 0, color: 0, lineAbove: false, forks: [] });
});
