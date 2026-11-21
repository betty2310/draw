import type { Env } from "./index.ts";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    thumb TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  // The account at a sign-in provider. A second provider adds rows, not columns.
  `CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (provider, subject)
  )`,
  // The id is the SHA-256 of the cookie token, so a copy of the database gives no session.
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Each user has one workspace now. A shared workspace needs only a members table later.
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces (owner_id)",
];

async function createSchema(DB: D1Database) {
  await DB.batch(TABLES.map((sql) => DB.prepare(sql)));
  // The projects of the first version have no workspace. They stay hidden until an owner gets them.
  const { results } = await DB.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
  if (!results.some((column) => column.name === "workspace_id")) {
    await DB.prepare(
      "ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
    ).run();
  }
  await DB.prepare(
    "CREATE INDEX IF NOT EXISTS projects_workspace ON projects (workspace_id, deleted_at, updated_at)",
  ).run();
}

// One check for each Worker instance, so a new database (local dev, tests) needs no manual step.
let schemaReady: Promise<unknown> | undefined;
export function db(env: Env): Promise<D1Database> {
  schemaReady ??= createSchema(env.DB).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady.then(() => env.DB);
}
