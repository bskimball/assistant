import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { todosCollection, createTodo, hydrateTodosFromServer, upsertTodoClient, deleteTodoClient, type Todo, todayKey, SEED_TODOS } from '@/lib/todos'
import { loadTodos, saveTodos, ensureInitialTodos } from '@/lib/server/todos'
import { Input } from '@/components/ui/input'

// Preload todos from R2 during SSR / route load (serverFn runs on server)
export const Route = createFileRoute('/')({
  loader: async () => {
    try {
      return await loadTodos()
    } catch (e) {
      console.warn('[R2] Failed to loadTodos in loader, will fallback client-side:', e)
      return { items: [], updatedAt: Date.now() }
    }
  },
  component: DailyPage,
})

function DailyPage() {
  const initialData = Route.useLoaderData()
  const [todos, setTodos] = useState<Todo[]>([])
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all')
  const [syncing, setSyncing] = useState(false)

  // Hydrate client collection + local state from server loader data + subscribe to collection
  useEffect(() => {
    // 1. Seed from route loader data (R2)
    if (initialData?.items?.length) {
      hydrateTodosFromServer(initialData.items)
    }

    // 2. If still empty after initialData, try server seed (first-run) with fallback
    async function maybeSeedFromServer() {
      if (todosCollection.state.size === 0) {
        try {
          const seededData = await ensureInitialTodos({ data: SEED_TODOS })
          if (seededData?.items?.length) {
            hydrateTodosFromServer(seededData.items)
          }
        } catch (e) {
          console.warn('[R2] ensureInitialTodos failed, using local seeds (UI only until write):', e)
          SEED_TODOS.forEach((t) => {
            if (!todosCollection.state.has(t.id)) todosCollection.insert(t)
          })
        }
      }
    }

    maybeSeedFromServer()

    // Use subscribeChanges (current @tanstack/db API). We snapshot state on change.
    const sub = todosCollection.subscribeChanges(() => {
      const all = Array.from(todosCollection.state.values()) as unknown as Todo[]
      setTodos(all)
    })

    // Prime local state (cast because of virtual row wrappers in state)
    setTodos(Array.from(todosCollection.state.values()) as unknown as Todo[])

    return () => sub.unsubscribe()
  }, [initialData])

  const today = todayKey()
  const todayTodos = todos.filter(t => t.date === today)

  const filtered = todayTodos.filter(todo => {
    if (filter === 'active') return !todo.done
    if (filter === 'done') return todo.done
    return true
  })

  const activeCount = todayTodos.filter((t) => !t.done).length
  const doneCount = todayTodos.filter((t) => t.done).length
  const progress = todayTodos.length > 0 ? Math.round((doneCount / todayTodos.length) * 100) : 0

  // Write current full snapshot to R2 (source of truth)
  async function persistToR2(items: Todo[]) {
    setSyncing(true)
    try {
      await saveTodos({ data: { items } })
    } catch (e) {
      console.error('[R2] Failed to saveTodos', e)
      // Optimistic UI keeps working; a future toast/banner can surface errors.
    } finally {
      setSyncing(false)
    }
  }

  function handleAdd(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!input.trim()) return

    const newTodo = createTodo(input.trim())
    upsertTodoClient(newTodo)
    setInput('')

    persistToR2(Array.from(todosCollection.state.values()) as unknown as Todo[])
  }

  function toggleDone(id: string) {
    const todo = todosCollection.state.get(id)
    if (!todo) return

    const updated: Todo = {
      ...todo,
      done: !todo.done,
      completedAt: !todo.done ? Date.now() : null,
    }
    upsertTodoClient(updated)

    persistToR2(Array.from(todosCollection.state.values()) as unknown as Todo[])
  }

  function deleteTodo(id: string) {
    deleteTodoClient(id)

    persistToR2(Array.from(todosCollection.state.values()) as unknown as Todo[])
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8 bg-background">
      <div className="w-full max-w-[680px]">
        {/* Header */}
        <div className="mb-8">
          <h1 className="display-title text-[2.75rem] leading-none tracking-[-0.02em] text-foreground">
            Aerolist
          </h1>
          <p className="text-[0.875rem] text-muted-foreground mt-1">
            a quiet place for things that matter
          </p>
        </div>

        {/* Stats */}
        <div className="flex items-baseline justify-between text-[0.8125rem] font-medium tracking-[0.01em] mb-3 text-muted-foreground">
          <div>
            {todayTodos.length} tasks · {activeCount} active · {doneCount} done
          </div>
          <div className="tabular-nums">{progress}%</div>
        </div>

        {/* Progress bar */}
        <div className="h-[2px] bg-border mb-6 overflow-hidden">
          <div 
            className="h-full bg-primary transition-all" 
            style={{ width: `${progress}%` }} 
          />
        </div>

        {/* Input */}
        <form onSubmit={handleAdd} className="mb-6">
          <div className="ledger-input-wrap relative flex items-center">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Write something worth doing…"
              className="ledger-input border-0 border-b border-border focus:border-primary bg-transparent text-[1.0625rem] py-3 px-0 rounded-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
            />
            <button 
              type="submit"
              className="ml-2 text-muted-foreground hover:text-primary transition-colors"
              aria-label="Add task"
            >
              →
            </button>
          </div>
        </form>

        {/* Filters */}
        <div className="flex gap-4 text-[0.875rem] mb-4 border-b border-border pb-2">
          {(['all', 'active', 'done'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`ledger-tab pb-1 capitalize ${filter === f ? 'text-primary after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="space-y-1 mb-8">
          {filtered.length === 0 && (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Nothing here. Add your first task above.
            </div>
          )}
          {filtered.map(todo => (
            <div 
              key={todo.id} 
              className={`group flex items-start gap-3 py-2.5 px-1 rounded-md hover:bg-accent/30 transition-colors ${todo.done ? 'text-muted-foreground' : ''}`}
            >
              <button
                onClick={() => toggleDone(todo.id)}
                className={`mt-1 size-5 rounded-full border flex-shrink-0 transition-all ${todo.done ? 'bg-primary border-primary' : 'border-border hover:border-primary'}`}
                aria-label={todo.done ? 'Mark undone' : 'Mark done'}
              >
                {todo.done && <span className="block text-primary-foreground text-xs leading-[18px]">✓</span>}
              </button>
              
              <div className="flex-1 min-w-0 pt-0.5">
                <div className={`text-[1rem] leading-snug ${todo.done ? 'line-through' : ''}`}>
                  {todo.text}
                </div>
                {todo.notes && (
                  <div className="text-sm text-muted-foreground mt-0.5">{todo.notes}</div>
                )}
              </div>

              <button 
                onClick={() => deleteTodo(todo.id)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all text-xs px-2"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {doneCount > 0 && (
          <button
            onClick={() => {
              todayTodos
                .filter((t) => t.done)
                .forEach((t) => deleteTodoClient(t.id))
              persistToR2(Array.from(todosCollection.state.values()) as unknown as Todo[])
            }}
            className="text-[0.75rem] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            Clear completed
          </button>
        )}

        <div className="mt-10 text-[0.6875rem] text-muted-foreground/70 flex items-center gap-2">
          Built with TanStack Start • Cloudflare R2 • {today}
          {syncing && <span className="text-[10px] opacity-60">(syncing…)</span>}
        </div>
      </div>
    </div>
  )
}
