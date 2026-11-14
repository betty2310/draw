import { Hono } from "hono";
import {
  MAX_IMAGE_BYTES,
  type HealthResponse,
  type Project,
  type ProjectPatch,
} from "@draw/shared";
import { ProjectRepo } from "./project-repo.ts";

export { ProjectRepo };

export interface Env {
  PROJECT_REPO: DurableObjectNamespace<ProjectRepo>;
  DB: D1Database;
}

const PROJECTS_SCHEMA = `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  thumb TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`;

/** A thumbnail is a small PNG data URL. This limit keeps the project list fast. */
const MAX_THUMB_CHARS = 200_000;

// One check for each Worker instance, so a new database (local dev, tests) needs no manual step.
let schemaReady: Promise<unknown> | undefined;
function db(env: Env): Promise<D1Database> {
  schemaReady ??= env.DB.prepare(PROJECTS_SCHEMA)
    .run()
    .catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  return schemaReady.then(() => env.DB);
}

interface ProjectRow {
  id: string;
  name: string;
  thumb: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  thumb: row.thumb,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const cleanName = (name: unknown) =>
  typeof name === "string" ? name.trim().slice(0, 200) : undefined;

export const app = new Hono<{ Bindings: Env }>()
  .get("/api/health", async (c) => {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    const colo = (c.req.raw.cf?.colo as string | undefined) ?? "local";
    return c.json<HealthResponse>({ ok: row?.ok === 1, colo });
  })
  .get("/api/projects", async (c) => {
    const trash = c.req.query("trash") === "1";
    const { results } = await (
      await db(c.env)
    )
      .prepare(
        `SELECT * FROM projects WHERE deleted_at IS ${trash ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC`,
      )
      .all<ProjectRow>();
    return c.json<Project[]>(results.map(toProject));
  })
  .post("/api/projects", async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
    const now = Date.now();
    const row: ProjectRow = {
      id: crypto.randomUUID(),
      name: cleanName(body.name) || "Untitled",
      thumb: "",
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await (
      await db(c.env)
    )
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, row.name, now, now)
      .run();
    return c.json<Project>(toProject(row), 201);
  })
  .get("/api/projects/:id", async (c) => {
    const row = await (
      await db(c.env)
    )
      .prepare("SELECT * FROM projects WHERE id = ?")
      .bind(c.req.param("id"))
      .first<ProjectRow>();
    return row ? c.json<Project>(toProject(row)) : c.json({ error: "Not found" }, 404);
  })
  .patch("/api/projects/:id", async (c) => {
    const patch = await c.req.json<ProjectPatch>();
    const sets: string[] = [];
    const values: unknown[] = [];
    const name = cleanName(patch.name);
    if (name) {
      sets.push("name = ?");
      values.push(name);
    }
    if (typeof patch.trashed === "boolean") {
      sets.push("deleted_at = ?");
      values.push(patch.trashed ? Date.now() : null);
    }
    if (typeof patch.thumb === "string" && patch.thumb.length <= MAX_THUMB_CHARS) {
      // A new thumbnail comes after a save, so the project moves to the top of the list.
      sets.push("thumb = ?", "updated_at = ?");
      values.push(patch.thumb, Date.now());
    }
    if (sets.length === 0) return c.json({ error: "Nothing to change" }, 400);
    const row = await (
      await db(c.env)
    )
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .bind(...values, c.req.param("id"))
      .first<ProjectRow>();
    return row ? c.json<Project>(toProject(row)) : c.json({ error: "Not found" }, 404);
  })
  .get("/api/projects/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected a WebSocket upgrade", 426);
    }
    return c.env.PROJECT_REPO.getByName(c.req.param("id")).fetch(c.req.raw);
  })
  .put("/api/projects/:id/images/:fileId", async (c) => {
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) return c.json({ error: "The image is too large" }, 413);
    const mime = c.req.header("Content-Type") ?? "application/octet-stream";
    await c.env.PROJECT_REPO.getByName(c.req.param("id")).putImage(
      c.req.param("fileId"),
      mime,
      bytes,
    );
    return c.body(null, 204);
  })
  .get("/api/projects/:id/images/:fileId", async (c) => {
    const image = await c.env.PROJECT_REPO.getByName(c.req.param("id")).getImage(
      c.req.param("fileId"),
    );
    if (!image) return c.json({ error: "Not found" }, 404);
    return c.body(image.bytes, 200, {
      "Content-Type": image.mime,
      // The file id is the hash of the content, so an image never changes.
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
