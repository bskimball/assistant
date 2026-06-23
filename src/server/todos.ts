/**
 * Server functions for Todo persistence backed by R2.
 *
 * All persistence goes through R2 (see ADR-001).
 * These are callable from client via createServerFn.
 *
 * IMPORTANT: We dynamically import the R2 layer *inside handlers* only.
 * This prevents the "cloudflare:workers" virtual module (and server-only code)
 * from being pulled into the client bundle.
 *
 * Data location:
 *   assistant/{USER_ID}/todos.json
 */

import { createServerFn } from "@tanstack/react-start";
import type { Todo } from "@/lib/todos";
import { requireAuthSession } from "@/lib/auth";
import { getDomainStore } from "@/server/store";

export type StoredTodos = {
  items: Todo[];
  updatedAt: number;
};

/**
 * Load all todos for the current user from R2.
 */
export async function loadTodosImpl(): Promise<StoredTodos> {
  const store = await getDomainStore();
  const stored = await store.ref.get<StoredTodos>("todos.json");
  if (stored && Array.isArray(stored.items)) {
    return stored;
  }
  return { items: [], updatedAt: Date.now() } satisfies StoredTodos;
}

export const loadTodos = createServerFn({ method: "GET" }).handler(loadTodosImpl);

/**
 * Replace the entire todos collection in R2 (last-write-wins).
 */
export const saveTodos = createServerFn({ method: "POST" })
  .validator((data: { items: Todo[] }) => data)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return saveTodosImpl(ctx.data);
  });

export async function saveTodosImpl(data: { items: Todo[] }): Promise<StoredTodos> {
  const store = await getDomainStore();
  const payload: StoredTodos = {
    items: data.items,
    updatedAt: Date.now(),
  };
  await store.ref.put("todos.json", payload);
  return payload;
}

/**
 * Seed initial data if the collection is empty in R2.
 */
export const ensureInitialTodos = createServerFn({ method: "POST" })
  .validator((seed: Todo[]) => seed)
  .handler(async (ctx: any) => {
    await requireAuthSession(ctx.request);
    return ensureInitialTodosImpl(ctx.data);
  });

export async function ensureInitialTodosImpl(seed: Todo[]): Promise<StoredTodos> {
  const store = await getDomainStore();
  const existing = await store.ref.get<StoredTodos>("todos.json");
  if (existing && existing.items.length > 0) {
    return existing;
  }
  const payload: StoredTodos = { items: seed, updatedAt: Date.now() };
  await store.ref.put("todos.json", payload);
  return payload;
}
