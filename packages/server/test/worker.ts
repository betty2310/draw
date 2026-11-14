// The Worker of the Durable Object tests. It adds routes that move the clock of one project and
// run the delete of old versions, which waits one day in production.
import app, { ProjectRepo as Base, type Env } from "../src/index.ts";

export class ProjectRepo extends Base {
  // Kept in storage, so the offset stays if the object leaves memory between two test steps.
  protected override now(): number {
    return Date.now() + (this.ctx.storage.kv.get<number>("test-clock") ?? 0);
  }

  async moveClock(ms: number): Promise<void> {
    this.ctx.storage.kv.put(
      "test-clock",
      (this.ctx.storage.kv.get<number>("test-clock") ?? 0) + ms,
    );
  }

  /** Runs the alarm now, as the runtime does, and returns the time of the next run. */
  async runCleanup(): Promise<{ next: number | null; now: number }> {
    // The runtime removes an alarm before it runs it.
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
    return { next: await this.ctx.storage.getAlarm(), now: this.now() };
  }

  async cleanupTime(): Promise<{ next: number | null; now: number }> {
    return { next: await this.ctx.storage.getAlarm(), now: this.now() };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/test\/([\w-]+)\/(clock|cleanup|alarm)$/.exec(url.pathname);
    if (!match) return app.fetch(request, env);
    const stub = env.PROJECT_REPO.getByName(match[1]!) as unknown as DurableObjectStub<ProjectRepo>;
    if (match[2] === "clock") {
      await stub.moveClock(Number(url.searchParams.get("ms")));
      return new Response(null, { status: 204 });
    }
    return Response.json(
      match[2] === "cleanup" ? await stub.runCleanup() : await stub.cleanupTime(),
    );
  },
} satisfies ExportedHandler<Env>;
