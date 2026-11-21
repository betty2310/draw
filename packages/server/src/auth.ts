import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { sha256Hex, type User } from "@draw/shared";
import { db } from "./db.ts";
import type { Env } from "./index.ts";

/** The signed-in user of a request. */
export interface SessionUser extends User {
  workspaceId: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

const SESSION_COOKIE = "__Host-draw_session";
/** Holds the state, the nonce and the PKCE verifier between the redirect to Google and the return. */
const SIGNIN_COOKIE = "__Host-draw_signin";

const DAY = 24 * 60 * 60 * 1000;
const SESSION_MS = 30 * DAY;
/** A session that is used again with less than this time left gets the full time again. */
const EXTEND_BELOW_MS = 15 * DAY;
const SIGNIN_MS = 10 * 60 * 1000;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const cookieOptions = (maxAgeMs: number) =>
  ({ path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: maxAgeMs / 1000 }) as const;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes as UTF-8, so a Vietnamese name in the ID token stays correct. */
function fromBase64url(text: string): string {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** The session id in D1 is the SHA-256 of the cookie token. */
const sessionIdOf = (token: string) => sha256Hex(new TextEncoder().encode(token).slice());

const callbackUrl = (c: Context) => new URL("/api/auth/google/callback", c.req.url).href;

/** Only a path on this site, so the sign-in cannot send the browser to a different site. */
const safeNext = (next: unknown) =>
  typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/";

interface SignIn {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

interface GoogleClaims {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * The browser refuses the HTTP status of a WebSocket upgrade, so a refused socket is accepted and
 * closed with 4000 + the status. Other requests get a JSON error.
 */
export function refuse(c: Context, status: 401 | 403 | 404, error: string): Response {
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error }, status);
  const { 0: browser, 1: server } = new WebSocketPair();
  server.accept();
  server.close(4000 + status, error);
  return new Response(null, { status: 101, webSocket: browser });
}

interface SessionRow {
  id: string;
  email: string;
  name: string;
  picture: string;
  workspace_id: string;
  expires_at: number;
}

async function readSession(c: Context<AppEnv>, token: string): Promise<SessionUser | null> {
  const DB = await db(c.env);
  const sessionId = await sessionIdOf(token);
  const now = Date.now();
  const row = await DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, w.id AS workspace_id, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN workspaces w ON w.owner_id = u.id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sessionId, now)
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at - now < EXTEND_BELOW_MS) {
    await DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(now + SESSION_MS, sessionId)
      .run();
    setCookie(c, SESSION_COOKIE, token, cookieOptions(SESSION_MS));
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    workspaceId: row.workspace_id,
  };
}

/** Sets `user`, or refuses the request with 401. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await readSession(c, token) : null;
  if (!user) return refuse(c, 401, "Sign in first");
  c.set("user", user);
  await next();
});

/**
 * Sends the code to Google and returns the claims of the ID token. The token comes straight from
 * Google's token endpoint over TLS, so its signature check is not necessary (OpenID Connect Core
 * 3.1.3.7, item 6). This keeps the sign-in far below the 10 ms CPU limit of Workers Free.
 */
async function exchangeCode(c: Context<AppEnv>, code: string, verifier: string) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token endpoint: ${response.status} ${await response.text()}`);
  }
  const { id_token } = await response.json<{ id_token?: string }>();
  const payload = id_token?.split(".")[1];
  if (!payload) throw new Error("Google sent no ID token");
  return JSON.parse(fromBase64url(payload)) as GoogleClaims;
}

function checkClaims(claims: GoogleClaims, clientId: string, nonce: string): string | null {
  if (!GOOGLE_ISSUERS.includes(claims.iss)) return "wrong issuer";
  if (claims.aud !== clientId) return "wrong audience";
  if (!(claims.exp * 1000 > Date.now())) return "expired";
  if (claims.nonce !== nonce) return "wrong nonce";
  if (typeof claims.sub !== "string" || !claims.sub) return "no subject";
  if (claims.email_verified !== true || !claims.email) return "email not verified";
  return null;
}

/** Finds the user of the Google account, or makes the user and their workspace. */
async function findOrCreateUser(DB: D1Database, claims: GoogleClaims): Promise<string> {
  const email = claims.email!.slice(0, 200);
  const name = (claims.name?.trim() || email).slice(0, 100);
  const picture = (claims.picture ?? "").slice(0, 500);
  const found = await DB.prepare(
    "SELECT user_id FROM identities WHERE provider = 'google' AND subject = ?",
  )
    .bind(claims.sub)
    .first<{ user_id: string }>();
  if (found) {
    // The name and the picture follow the Google account.
    await DB.prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?")
      .bind(email, name, picture, found.user_id)
      .run();
    return found.user_id;
  }
  const userId = crypto.randomUUID();
  const now = Date.now();
  await DB.batch([
    DB.prepare(
      "INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(userId, email, name, picture, now),
    DB.prepare("INSERT INTO identities (provider, subject, user_id) VALUES ('google', ?, ?)").bind(
      claims.sub,
      userId,
    ),
    DB.prepare(
      "INSERT INTO workspaces (id, owner_id, name, created_at) VALUES (?, ?, 'Personal', ?)",
    ).bind(crypto.randomUUID(), userId, now),
  ]);
  return userId;
}

async function startSession(c: Context<AppEnv>, DB: D1Database, userId: string) {
  const token = randomToken();
  const now = Date.now();
  await DB.batch([
    DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sessionIdOf(token), userId, now + SESSION_MS, now),
  ]);
  setCookie(c, SESSION_COOKIE, token, cookieOptions(SESSION_MS));
}

export const authRoutes = new Hono<AppEnv>()
  /** Starts the sign-in. `next` is the page to open after it. */
  .get("/google", async (c) => {
    const signIn: SignIn = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      next: safeNext(c.req.query("next")),
    };
    setCookie(c, SIGNIN_COOKIE, JSON.stringify(signIn), cookieOptions(SIGNIN_MS));
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signIn.verifier)),
      ),
    );
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: callbackUrl(c),
      response_type: "code",
      scope: "openid email profile",
      state: signIn.state,
      nonce: signIn.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return c.redirect(url.href);
  })
  .get("/google/callback", async (c) => {
    const saved = getCookie(c, SIGNIN_COOKIE);
    deleteCookie(c, SIGNIN_COOKIE, { path: "/", secure: true });
    const signIn = saved ? (JSON.parse(saved) as SignIn) : null;
    const code = c.req.query("code");
    // A missing code is a cancel on the Google page. A wrong state is a forged return.
    if (!signIn || !code || c.req.query("state") !== signIn.state) {
      return c.redirect("/?signin=failed");
    }
    try {
      const claims = await exchangeCode(c, code, signIn.verifier);
      const problem = checkClaims(claims, c.env.GOOGLE_CLIENT_ID, signIn.nonce);
      if (problem) throw new Error(`The ID token is not valid: ${problem}`);
      const DB = await db(c.env);
      await startSession(c, DB, await findOrCreateUser(DB, claims));
      return c.redirect(safeNext(signIn.next));
    } catch (error) {
      console.error("Google sign-in failed", error);
      return c.redirect("/?signin=failed");
    }
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const sessionId = await sessionIdOf(token);
      await (await db(c.env)).prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.body(null, 204);
  })
  .get("/me", requireUser, (c) => {
    const { id, email, name, picture } = c.get("user");
    return c.json<User>({ id, email, name, picture });
  });
