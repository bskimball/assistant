/**
 * Lightweight, non-throwing session probe for route guards (ADR-010).
 *
 * `requireAuthSession` throws on missing auth and is meant for write paths.
 * Route guards need a plain boolean, so this reports whether the request is
 * authenticated and whether auth is even configured (the dev escape hatch:
 * with no Google/secret env, there's no way to sign in, so we don't gate).
 */

import { createServerFn } from "@tanstack/react-start";
import { getAuth, isAuthConfigured } from "@/lib/auth";

export interface SessionState {
  authenticated: boolean;
  configured: boolean;
}

export const getSessionState = createServerFn({ method: "GET" }).handler(
  async (ctx: any): Promise<SessionState> => {
    const configured = await isAuthConfigured();
    if (!configured) return { authenticated: false, configured: false };
    try {
      const auth = (await getAuth()) as any;
      const headers = ctx?.request?.headers ?? new Headers();
      const session = await auth.api.getSession({ headers });
      return { authenticated: !!session?.user, configured: true };
    } catch {
      return { authenticated: false, configured: true };
    }
  },
);
