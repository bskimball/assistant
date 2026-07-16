/**
 * Global function middleware that binds the per-user data scope (ADR-017).
 *
 * Registered as `functionMiddleware` in `src/start.ts`, so it wraps every
 * server-function call — which is the only place domain data is accessed. It
 * resolves the Better Auth session, maps the user's email to a stable scope id,
 * and runs the handler inside that scope. The R2 store layer (`getDomainStore`)
 * then reads the scope from async context.
 *
 * Dev escape hatch: when auth is not configured in local development there's
 * no way to sign in, so we bind the default `brian` scope to keep local work
 * moving. Production must fail closed if auth secrets are missing.
 *
 * Security: when auth IS configured but the request is unauthenticated, we do
 * NOT bind a scope. `getDomainStore` then throws rather than silently falling
 * back to a default, so one user can never read/write another's data.
 *
 * All server-only modules (`@/lib/auth` → `cloudflare:workers`,
 * `request-context` → `node:async_hooks`) are imported dynamically inside the
 * `.server()` handler so they are never bundled into client code.
 */

import { createMiddleware } from "@tanstack/react-start";

export const userScopeMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    // All domain-store access happens inside server functions, so a function
    // middleware covers every path that touches domain data — including server
    // fns invoked during SSR. `getRequest()` yields the active request (with
    // auth cookies) in that server context.
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      if (typeof server.getRequest === "function") {
        request = server.getRequest();
      }
    } catch {
      request = undefined;
    }
    const scope = await resolveScopeForRequest(request);
    if (scope) {
      const { runWithUserScope } = await import("@/server/request-context.server");
      return runWithUserScope(scope, () => next());
    }
    return next();
  },
);

async function resolveScopeForRequest(request: Request | undefined): Promise<string | null> {
  const { getAuth, isAllowedLoginEmail, isAuthConfigured, isLocalDevRequest } =
    await import("@/lib/auth");
  const { resolveUserScope } = await import("@/lib/scope");

  const configured = await isAuthConfigured();
  // No auth configured → local dev fallback only. Production must fail closed.
  if (!configured) {
    return isLocalDevRequest(request) ? "brian" : null;
  }
  if (!request) return null;

  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    const email = session?.user?.email;
    if (email && isAllowedLoginEmail(email)) {
      return resolveUserScope(email);
    }
  } catch {
    // Fall through: unauthenticated/uncertain → no scope bound (store throws).
  }
  return null;
}
