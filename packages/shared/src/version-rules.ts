// The owner did not confirm these defaults from the plan ("Decisions", item 2).
// Change them only here.

/** A version stays open for autosave writes for this time after its creation. */
export const VERSION_OPEN_MS = 5 * 60 * 1000;

/** The server deletes versions with no name that are older than this. */
export const UNNAMED_VERSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface VersionState {
  createdAt: number;
  author: string;
  /** Empty for a version with no name. */
  name: string;
  /** true when a branch was created from this version. */
  branchedFrom: boolean;
}

/**
 * An autosave writes into the newest version of the branch while that version is open.
 * Otherwise the server adds a new version.
 */
export function isVersionOpen(version: VersionState, save: { now: number; author: string }) {
  return (
    save.now - version.createdAt < VERSION_OPEN_MS &&
    version.name === "" &&
    !version.branchedFrom &&
    version.author === save.author
  );
}
