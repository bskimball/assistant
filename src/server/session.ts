/**
 * Lightweight, non-throwing session probe for route guards (ADR-010).
 *
 * `requireAuthSession` throws on missing auth and is meant for write paths.
 * Route guards need a plain boolean, so this reports whether the request is
 * authenticated and whether auth is even configured. Missing auth config is a
 * local-dev escape hatch only; production reports configured so the root guard
 * fails closed instead of exposing the app.
 */

import { createServerFn } from "@tanstack/react-start";
import { getAuth, isAllowedLoginEmail, isAuthConfigured, isLocalDevRequest } from "@/lib/auth";

export interface SessionState {
  authenticated: boolean;
  configured: boolean;
}

export const getSessionState = createServerFn({ method: "GET" }).handler(
  async (ctx: any): Promise<SessionState> => {
    const configured = await isAuthConfigured();
    if (!configured) {
      return {
        authenticated: false,
        configured: !isLocalDevRequest(ctx?.request),
      };
    }
    try {
      const auth = (await getAuth()) as any;
      const headers = ctx?.request?.headers ?? new Headers();
      const session = await auth.api.getSession({ headers });
      return {
        authenticated: !!session?.user && isAllowedLoginEmail(session.user.email),
        configured: true,
      };
    } catch {
      return { authenticated: false, configured: true };
    }
  },
);
