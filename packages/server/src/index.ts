import { Hono } from "hono";
import type { HealthResponse } from "@draw/shared";
import { ProjectRepo } from "./project-repo.ts";

export { ProjectRepo };

export interface Env {
  PROJECT_REPO: DurableObjectNamespace<ProjectRepo>;
  DB: D1Database;
}

export const app = new Hono<{ Bindings: Env }>()
  .get("/api/health", async (c) => {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    const colo = (c.req.raw.cf?.colo as string | undefined) ?? "local";
    return c.json<HealthResponse>({ ok: row?.ok === 1, colo });
  })
  .get("/api/projects/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected a WebSocket upgrade", 426);
    }
    return c.env.PROJECT_REPO.getByName(c.req.param("id")).fetch(c.req.raw);
  });

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
