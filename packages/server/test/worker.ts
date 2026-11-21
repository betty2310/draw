// The Worker of the Durable Object tests. It adds routes that move the clock of one project and
// run the delete of old versions, which waits one day in production, and a fake Google.
import app, { ProjectRepo as Base, type Env } from "../src/index.ts";

// The tests cannot reach Google. This fake token endpoint returns an ID token with the claims that
// the test put in the code. It refuses a wrong client secret, and a PKCE verifier that does not
// match the challenge that the test copied from the redirect to Google.
const realFetch = globalThis.fetch;
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url !== "https://oauth2.googleapis.com/token") return realFetch(input, init);
  // The Worker sends the form as URLSearchParams.
  const form = new URLSearchParams(init?.body as URLSearchParams);
  const code = Uint8Array.from(atob(form.get("code")!), (char) => char.charCodeAt(0));
  const { claims, challenge } = JSON.parse(new TextDecoder().decode(code)) as {
    claims: object;
    challenge: string;
  };
  const verifier = new TextEncoder().encode(form.get("code_verifier") ?? "");
  const actual = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", verifier)));
  if (form.get("client_secret") !== "test-secret" || actual !== challenge) {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  return Response.json({ id_token: `header.${payload}.signature` });
};

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
