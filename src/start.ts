/**
 * Global TanStack Start configuration (ADR-017).
 *
 * Registers the request-scoped user middleware so every request (and the
 * server functions invoked within it) runs inside the correct per-user data
 * scope. See `src/server/auth-middleware.ts`.
 */

import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { userScopeMiddleware } from "@/server/auth-middleware";

const NOINDEX_HEADER = "noindex, nofollow";

/**
 * CSRF protection for server functions. They are same-origin RPC endpoints, so
 * we reject cross-site requests (Sec-Fetch-Site / Origin / Referer checks). This
 * is a `requestMiddleware` because it gates the request boundary; the `filter`
 * scopes it to server-function calls only, leaving normal document navigations
 * untouched.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Keep Compass out of search indexes even if a crawler reaches the Worker.
 */
const noIndexMiddleware = createMiddleware({ type: "request" }).server(async ({ next }) => {
  const result = await next();
  const { response } = result;
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", NOINDEX_HEADER);
  return {
    ...result,
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
});

/**
 * Bind the per-user scope on every server-function call (ADR-017). All domain
 * data access goes through server functions, so `functionMiddleware` covers
 * every path — including server fns invoked during SSR. Without this, the
 * client-side dashboard/coach refetches run with no scope bound and the store's
 * anti-leak guard throws.
 */
export const startInstance = createStart(() => ({
  requestMiddleware: [noIndexMiddleware, csrfMiddleware],
  functionMiddleware: [userScopeMiddleware],
}));
