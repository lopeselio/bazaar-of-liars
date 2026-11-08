/**
 * Sign in with a NEAR wallet, through Better Auth and its better-near-auth plugin (SIWN, NEP-413).
 *
 * The plugin hands out a nonce for the account, the wallet (via NEAR Connect) signs
 * "Sign in to <recipient>", and the plugin verifies the signature, that the key is a full-access
 * key of the account (onchain), and that the nonce is unused, then opens a Better Auth session
 * (an HttpOnly cookie). Here:
 * - the recipient is our own host, so the wallet shows players our domain, and a signature made
 *   for any other site (or sent from another origin) is refused (a before-hook: the plugin and
 *   Better Auth don't check this themselves);
 * - only full-access keys sign in;
 * - sessions last 24 hours;
 * - Better Auth only trusts requests from our own origin.
 * The player is the NEAR account the session is linked to (its primary `nearAccount`).
 *
 * Storage: Postgres when DATABASE_URL is set (the hosted demo, shared by all replicas), otherwise
 * Better Auth's in-memory adapter (local play and tests).
 */
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { siwn } from "better-near-auth";
import pg from "pg";

export const BETTER_AUTH_PATH = "/api/ba";
const SESSION_SECONDS = 24 * 3600;

export function betterAuthFromEnv(env = process.env) {
  const baseURL = env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT ?? 8787}`;
  const origin = new URL(baseURL).origin;
  const host = new URL(baseURL).host;
  const secret = env.BETTER_AUTH_SECRET ?? env.SESSION_SECRET;
  if (!secret && env.NODE_ENV === "production") throw new Error("BETTER_AUTH_SECRET (or SESSION_SECRET) must be set in production");
  const database = env.DATABASE_URL
    ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, ssl: env.DATABASE_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false } })
    : memoryAdapter({ user: [], session: [], account: [], verification: [], nearAccount: [], relayedTransaction: [], relayerKey: [] });
  const auth = betterAuth({
    appName: "Bazaar of Liars",
    baseURL,
    basePath: BETTER_AUTH_PATH,
    secret: secret ?? "dev-only-not-a-secret-change-me-0123456789",
    database,
    trustedOrigins: [origin],
    session: { expiresIn: SESSION_SECONDS, cookieCache: { enabled: true, maxAge: 5 * 60 } },
    advanced: { defaultCookieAttributes: { sameSite: "lax", secure: baseURL.startsWith("https"), httpOnly: true } },
    hooks: {
      // better-near-auth checks the signature, the key and the nonce, but not WHICH site the
      // signature was made for, and Better Auth's origin check skips requests without cookies.
      // So: a sign-in must be signed for our host, with our exact message, sent from our origin.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/near/verify" && ctx.path !== "/near/link-account") return;
        const b = (ctx.body ?? {}) as { recipient?: unknown; message?: unknown };
        if (b.recipient !== host || b.message !== `Sign in to ${host}`) {
          throw new APIError("UNAUTHORIZED", { message: "This sign-in was signed for a different site." });
        }
        const from = ctx.request?.headers.get("origin");
        if (from !== origin) throw new APIError("FORBIDDEN", { message: "Sign in from the game's own page." });
      }),
    },
    plugins: [
      siwn({
        // The wallet signs "Sign in to <our host>"; the account suffix picks the network.
        recipients: { testnet: host, mainnet: host },
        requireFullAccessKey: true,
      }),
    ],
  });
  return { auth, baseURL, host, usesDatabase: !!env.DATABASE_URL };
}

export type BetterAuth = ReturnType<typeof betterAuthFromEnv>["auth"];

/** Create or update Better Auth's tables (Postgres only; the memory adapter needs none). */
export async function migrateBetterAuth(auth: BetterAuth) {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

export const betterAuthHandler = (auth: BetterAuth) => toNodeHandler(auth);

/**
 * The NEAR account a request's Better Auth session belongs to (its primary linked account), or
 * null. Cached briefly per session cookie, so ordinary game requests don't hit the database.
 */
export function sessionNearAccount(auth: BetterAuth) {
  const cache = new Map<string, { account: string | null; until: number }>();
  return async (headers: Record<string, string | string[] | undefined>): Promise<string | null> => {
    const cookie = String(headers.cookie ?? "");
    if (!cookie.includes("session_token")) return null;
    const hit = cache.get(cookie);
    if (hit && hit.until > Date.now()) return hit.account;
    const s = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    let account: string | null = null;
    if (s?.user?.id) {
      const ctx = await auth.$context;
      const near = await ctx.adapter.findOne<{ accountId: string }>({
        model: "nearAccount",
        where: [
          { field: "userId", operator: "eq", value: s.user.id },
          { field: "isPrimary", operator: "eq", value: true },
        ],
      });
      account = near?.accountId ?? null;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(cookie, { account, until: Date.now() + 60_000 });
    return account;
  };
}
