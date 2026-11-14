import { expect, test } from "vite-plus/test";
import { isVersionOpen, VERSION_OPEN_MS } from "./version-rules.ts";

const created = 1_000_000;
const version = { createdAt: created, author: "An", name: "", branchedFrom: false };

test("a version is open for 5 minutes after its creation, for the same person", () => {
  expect(isVersionOpen(version, { now: created + VERSION_OPEN_MS - 1, author: "An" })).toBe(true);
  expect(isVersionOpen(version, { now: created + VERSION_OPEN_MS, author: "An" })).toBe(false);
  expect(isVersionOpen(version, { now: created + 1, author: "Binh" })).toBe(false);
});

test("a name or a branch closes the version early", () => {
  const save = { now: created + 1, author: "An" };
  expect(isVersionOpen({ ...version, name: "Draft 1" }, save)).toBe(false);
  expect(isVersionOpen({ ...version, branchedFrom: true }, save)).toBe(false);
});
