/**
 * D1 (SQLite) access layer — Better Auth backing store (ADR-010).
 *
 * Scope: authentication only (users / sessions / accounts / verification).
 * All domain data (nutrition, tasks, finance, plans, voice/AI logs) stays in
 * Cloudflare R2 via `src/server/adapters/r2.ts` + `src/server/domain.ts`.
 *
 * Pattern:
 * - Dynamic import of `cloudflare:workers` keeps this server-only.
 * - `getDb()` lazily binds drizzle to the D1 `DB` binding.
 * - `ensureSchema()` is an idempotent CREATE TABLE IF NOT EXISTS bootstrap so a
 *   fresh D1 database works without a separate migration step (single-user app).
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/db/schema";

// Re-export schema for the auth adapter / advanced use.
export { schema };

export type D1Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: D1Db | null = null;

async function getD1Binding(): Promise<D1Database | undefined> {
  const { env } = await import("cloudflare:workers");
  return (env as any)?.DB as D1Database | undefined;
}

/**
 * Get (or initialize) the drizzle instance backed by the D1 binding.
 * Safe to call multiple times.
 */
export async function getDb(): Promise<D1Db> {
  if (_db) return _db;
  const d1 = await getD1Binding();
  if (!d1) {
    throw new Error(
      'D1 binding "DB" is not available. Ensure wrangler.jsonc has the d1_databases ' +
        "binding (see ADR-010). Local dev: run `vp dev` (the Cloudflare Vite plugin " +
        "emulates D1 under .wrangler/state). Remote: `npx wrangler d1 create assistant-db` " +
        "then paste the id into wrangler.jsonc.",
    );
  }
  _db = drizzle(d1, { schema });
  return _db;
}

/**
 * Ensure the Better Auth tables exist (idempotent). Called before auth handling.
 * No-op when the binding is missing so non-auth code paths never crash in dev.
 */
export async function ensureSchema(): Promise<void> {
  const d1 = await getD1Binding();
  if (!d1) return;

  await d1.exec(
    `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );

  await d1.exec(
    `CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
  );

  await d1.exec(
    `CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );

  await d1.exec(
    `CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
}
