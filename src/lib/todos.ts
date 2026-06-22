import { createCollection } from '@tanstack/db'

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

export const STORAGE_KEY = "aerolist.todos" // for migration compat

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

// TanStack DB collection for todos - local only for now (with localStorage persist for reloads)
const PERSIST_KEY = 'aerolist.todos.v2'

function loadPersisted(): Todo[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function persist() {
  if (typeof window === 'undefined') return
  const all = Array.from(todosCollection.state.values())
  localStorage.setItem(PERSIST_KEY, JSON.stringify(all))
}

export const todosCollection = createCollection<Todo>({
  id: 'todos',
  getKey: (todo) => todo.id,
})

// Initial hydrate from localStorage (one-time or on load)
if (typeof window !== 'undefined') {
  const persisted = loadPersisted()
  if (persisted.length) {
    // Avoid duplicate inserts
    const existingIds = new Set(Array.from(todosCollection.state.keys()))
    persisted.forEach(item => {
      if (!existingIds.has(item.id)) {
        todosCollection.insert(item)
      }
    })
  }

  // Subscribe to persist changes
  todosCollection.subscribe(persist)
}

// Helper to load seeds if empty (one time)
export function ensureSeeds() {
  // In real, we'd check size or a flag, but for demo insert if empty
  // Note: collections start empty; migration from old localStorage will be added.
  if (todosCollection.state.size === 0) {
    SEED_TODOS.forEach(t => {
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
  const createdAt = Date.now()
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
