import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'

/**
 * Todo domain model and client-side reactive collection.
 *
 * Persistence is R2-backed via server functions (see src/lib/server/todos.ts and ADR-001).
 * TanStack DB collection here provides reactive client state only.
 */

export type Todo = {
  id: string
  text: string
  done: boolean
  createdAt: number
  date: string
  completedAt: number | null
  notes?: string
  source?: "inbox" | "daily"
  // AI-enriched optional metadata
  tags?: string[]
  priority?: 1 | 2 | 3
  due?: string
  project?: string
  estimatedMinutes?: number
  energy?: "low" | "medium" | "high"
}

export const STORAGE_KEY = "aerolist.todos" // legacy migration marker only

export function todayKey(): string {
  return toDayKey(Date.now())
}

export function toDayKey(ts: number): string {
  const d = new Date(ts)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export const SEED_TODOS: Todo[] = [
  {
    id: "seed-1",
    text: "Water the office plants",
    done: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 2,
    date: todayKey(),
    completedAt: null,
  },
  {
    id: "seed-2",
    text: "Reply to the design thread",
    done: false,
    createdAt: Date.now() - 1000 * 60 * 45,
    date: todayKey(),
    completedAt: null,
  },
  {
    id: "seed-3",
    text: "Ship the Aero revival",
    done: false,
    createdAt: Date.now() - 1000 * 60 * 10,
    date: todayKey(),
    completedAt: null,
  },
  {
    id: "seed-4",
    text: "Take a screen break ☆",
    done: true,
    createdAt: Date.now() - 1000 * 60 * 5,
    date: todayKey(),
    completedAt: Date.now() - 1000 * 60 * 5,
  },
]

/**
 * Client-only reactive collection (TanStack DB).
 * Source of truth for UI is R2. This is hydrated from server on load and kept in sync.
 *
 * Uses localOnlyCollectionOptions (required by current @tanstack/db).
 */
export const todosCollection = createCollection(
  localOnlyCollectionOptions<Todo>({
    id: 'todos',
    getKey: (todo) => todo.id,
  })
)

/**
 * Replace the entire contents of the client collection from a server payload.
 * Used after loading from R2.
 */
export function hydrateTodosFromServer(items: Todo[]) {
  // Clear current
  const currentIds = Array.from(todosCollection.state.keys())
  if (currentIds.length) {
    todosCollection.delete(currentIds)
  }

  // Insert fresh (local-only collection accepts the data)
  if (items.length) {
    todosCollection.insert(items)
  }
}

/**
 * Optimistically insert or update a todo in the client collection.
 * Call immediately for UI, then persist via serverFn.
 */
export function upsertTodoClient(todo: Todo) {
  if (todosCollection.state.has(todo.id)) {
    todosCollection.update(todo.id, (draft) => {
      Object.assign(draft, todo)
    })
  } else {
    todosCollection.insert(todo)
  }
}

/**
 * Remove from client collection.
 */
export function deleteTodoClient(id: string) {
  todosCollection.delete(id)
}

/**
 * Legacy local seed helper (kept for fallback / first-run before R2 has data).
 * Prefer server ensure or seeds via load path.
 */
export function ensureSeeds() {
  if (todosCollection.state.size === 0) {
    SEED_TODOS.forEach((t) => {
      todosCollection.insert(t)
    })
  }
}

export function createTodo(text: string, date = todayKey()): Todo {
  const createdAt = Date.now()
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    done: false,
    createdAt,
    date,
    completedAt: null,
    source: "daily",
  }
}

export function createTodoFromParsed(
  parsed: {
    text: string
    notes?: string
    tags?: string[]
    priority?: 1 | 2 | 3
    due?: string
    project?: string
    estimatedMinutes?: number
    energy?: "low" | "medium" | "high"
  },
  date = todayKey()
): Todo {
  const base = createTodo(parsed.text, date)
  return {
    ...base,
    notes: parsed.notes,
    tags: parsed.tags?.length ? parsed.tags : undefined,
    priority: parsed.priority,
    due: parsed.due,
    project: parsed.project,
    estimatedMinutes: parsed.estimatedMinutes,
    energy: parsed.energy,
  }
}
