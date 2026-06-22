/**
 * Better Auth catch-all handler (ADR-010).
 * Mounted at /api/auth/*
 *
 * Uses TanStack Start server route pattern (recommended for Better Auth + TS Start).
 *
 * All auth flows (signIn.social({ provider: 'google' }), getSession, signOut, etc.) go through here.
 *
 * Ensure schema (auth + domain tables) before first use.
 */

import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";

async function ensureSchemaSafe() {
  try {
    const { ensureSchema } = await import("@/server/db");
    await ensureSchema();
  } catch {
    // Non-fatal in dev
  }
}

async function handleAuth(request: Request) {
  await ensureSchemaSafe();
  const auth = (await getAuth()) as any;
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => handleAuth(request),
      POST: async ({ request }) => handleAuth(request),
    },
  },
});
