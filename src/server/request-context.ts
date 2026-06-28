/**
 * Request-scoped user context (ADR-017).
 *
 * Carries the resolved per-user scope (e.g. `brian` / `sophia`) for the
 * lifetime of a single request so the R2 store layer can pick the correct
 * data prefix without threading a userId through every server function.
 *
 * Seeded once at the request boundary by the global request middleware
 * (`src/server/auth-middleware.ts`) and read by `getDomainStore()`
 * (`src/server/store.ts`). Relies on `AsyncLocalStorage`, available because
 * `wrangler.jsonc` enables the `nodejs_compat` compatibility flag.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface UserContext {
  /** Per-user scope id for personal data (e.g. "brian", "sophia"). */
  scope: string;
}

const storage = new AsyncLocalStorage<UserContext>();

/** Run `fn` with the given per-user scope bound to the async context. */
export function runWithUserScope<T>(scope: string, fn: () => T): T {
  return storage.run({ scope }, fn);
}

/** The current request's per-user scope, or null if none was bound. */
export function getCurrentUserScope(): string | null {
  return storage.getStore()?.scope ?? null;
}
