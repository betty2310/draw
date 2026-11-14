// The owner did not confirm these defaults from the plan ("Decisions", item 2).
// Change them only here.

/** A version stays open for autosave writes for this time after its creation. */
export const VERSION_OPEN_MS = 5 * 60 * 1000;

/** The server deletes versions with no name that are older than this. */
export const UNNAMED_VERSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
