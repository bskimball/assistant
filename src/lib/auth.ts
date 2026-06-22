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
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "@/server/db";

let _auth: any = null;

/**
 * Resolve a secret/env value preferring Cloudflare Workers env, then process.env, then globalThis.
 */
function getEnvValue(env: any, key: string): string | undefined {
  const e = env?.[key];
  if (e) return e;
  if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
  return (globalThis as any)?.[key];
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

  _auth = betterAuth({
    appName: "Brian's Life Assistant",

    baseURL: baseUrl,

    // Provide a placeholder in dev if missing (better-auth will still surface clear errors in prod)
    secret:
      secret ||
      (process.env.NODE_ENV === "production"
        ? undefined
        : "dev-only-insecure-do-not-use-in-prod-32chars!!"),

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

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh window
    },

    rateLimit: {
      enabled: true,
    },

    // Security: in production you may force secure cookies via advanced
    // advanced: { useSecureCookies: true },
  }) as any;

  return _auth;
}

// Type helpers (use the betterAuth factory type so $Infer is always available)
export type Session = ReturnType<typeof betterAuth>["$Infer"]["Session"];
export type User = Session["user"];

// NOTE: Do NOT eagerly instantiate at module scope in server bundles.
// Call getAuth() at request time (inside handlers / server fns).
