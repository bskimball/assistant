/**
 * Better Auth server instance (ADR-010).
 *
 * Google OAuth setup (required for sign-in):
 * - Create OAuth Client ID (Web) in Google Cloud Console (APIs & Services)
 * - Add these **Authorized redirect URIs**:
 *     http://localhost:3000/api/auth/callback/google
 *     http://127.0.0.1:3000/api/auth/callback/google
 *     https://your-project.pages.dev/api/auth/callback/google   ← replace with real prod URL
 *
 * Usage: getAuth().handler(req) in the catch-all API route.
 * Client: import from '@/lib/auth-client'
 */

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { getDb } from "@/server/adapters/d1";

let _auth: any = null;

const DEFAULT_ALLOWED_LOGIN_EMAILS = ["briankimball1982@gmail.com", "sophiamkimball@gmail.com"];

/**
 * Resolve a secret/env value preferring Cloudflare Workers env, then process.env, then globalThis.
 */
function getEnvValue(env: any, key: string): string | undefined {
  const e = env?.[key];
  if (e) return e;
  if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
  return (globalThis as any)?.[key];
}

function normalizeEmail(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

function parseEmailList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s;]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

export function getAllowedLoginEmails(env?: any): Set<string> {
  const configured = parseEmailList(
    getEnvValue(env, "ALLOWED_LOGIN_EMAILS") || getEnvValue(env, "AUTH_ALLOWED_EMAILS"),
  );
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_LOGIN_EMAILS);
}

export function isAllowedLoginEmail(email: string | null | undefined, env?: any): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length > 0 && getAllowedLoginEmails(env).has(normalized);
}

export function isLocalDevRequest(request?: Request): boolean {
  if (!request) return false;
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function isAuthConfigured(): Promise<boolean> {
  try {
    const { env } = await import("cloudflare:workers");
    return !!(
      getEnvValue(env, "GOOGLE_CLIENT_ID") &&
      getEnvValue(env, "GOOGLE_CLIENT_SECRET") &&
      getEnvValue(env, "BETTER_AUTH_SECRET")
    );
  } catch {
    return !!(
      getEnvValue(undefined, "GOOGLE_CLIENT_ID") &&
      getEnvValue(undefined, "GOOGLE_CLIENT_SECRET") &&
      getEnvValue(undefined, "BETTER_AUTH_SECRET")
    );
  }
}

export async function requireAuthSession(request?: Request): Promise<Session | null> {
  if (!request) return null;
  const configured = await isAuthConfigured();
  if (!configured) {
    if (isLocalDevRequest(request)) return null;
    throw new Error("Authentication is not configured for this deployment.");
  }

  const auth = (await getAuth()) as any;
  const headers = request?.headers ?? new Headers();
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    throw new Error("Authentication required.");
  }
  if (!isAllowedLoginEmail(session.user.email)) {
    throw new Error("This Google account is not allowed to access this assistant.");
  }
  return session as Session;
}

export async function getAuth() {
  if (_auth) return _auth;

  const { env } = await import("cloudflare:workers");

  // Reuse the shared drizzle instance (now includes domain + auth tables from schema)
  const db = await getDb();

  const googleClientId = getEnvValue(env, "GOOGLE_CLIENT_ID");
  const googleClientSecret = getEnvValue(env, "GOOGLE_CLIENT_SECRET");
  const secret = getEnvValue(env, "BETTER_AUTH_SECRET");
  const baseUrl = getEnvValue(env, "BETTER_AUTH_URL") || "http://localhost:3000";

  // WebAuthn relying-party id must be the registrable domain (hostname only).
  // Derived from the base URL so it's correct on localhost and the prod domain.
  const rpID = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "localhost";
    }
  })();

  _auth = betterAuth({
    appName: "Brian's Life Assistant",

    baseURL: baseUrl,

    // Provide a placeholder only for explicit development mode. Production and
    // unknown runtimes must not silently mint sessions with a fallback secret.
    secret:
      secret ||
      (process.env.NODE_ENV === "development"
        ? "dev-only-insecure-do-not-use-in-prod-32chars!!"
        : undefined),

    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),

    trustedOrigins: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      baseUrl,
      getEnvValue(env, "PUBLIC_APP_URL") || undefined,
    ]
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .filter((url, index, self) => self.indexOf(url) === index),

    socialProviders:
      googleClientId && googleClientSecret
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            },
          }
        : {},

    // Passkey / WebAuthn for biometric (fingerprint / Face ID) sign-in (ADR-017).
    // `origin` defaults to the request Origin header, so localhost and the
    // deployed HTTPS domain both work without per-env wiring.
    plugins: [
      passkey({
        rpID,
        rpName: "Brian's Life Assistant",
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          before: async (user: any) => {
            if (!isAllowedLoginEmail(user.email, env)) {
              throw new APIError("FORBIDDEN", {
                message: "This Google account is not allowed to access this assistant.",
              });
            }
            return { data: user };
          },
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh window
    },

    rateLimit: {
      enabled: true,
    },

    advanced: {
      // Cloudflare terminates the connection, so the trusted client IP is in
      // `cf-connecting-ip`. Without this, Better Auth can't determine a client
      // IP and rate-limits every request into one shared per-path bucket.
      // `x-forwarded-for` is a fallback for local/proxied dev.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      // Security: in production you may force secure cookies via
      // useSecureCookies: true,
    },
  }) as any;

  return _auth;
}

// Type helpers (use the betterAuth factory type so $Infer is always available)
export type Session = ReturnType<typeof betterAuth>["$Infer"]["Session"];
export type User = Session["user"];

// NOTE: Do NOT eagerly instantiate at module scope in server bundles.
// Call getAuth() at request time (inside handlers / server fns).
