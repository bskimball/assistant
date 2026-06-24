import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { VoiceInput } from '@/components/VoiceInput'
import {
  Trash2,
  Inbox,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Lock,
  Users,
  Dumbbell,
  Salad,
  Wallet,
  Loader,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Check,
  Undo2,
  Pencil,
  type LucideIcon,
} from 'lucide-react'
import {
  saveProductivityTasksForDay,
} from '@/server/domain'
import type { ProductivityTask, ISODate } from '@/lib/domain'
import {
  createProductivityTask,
  updateTaskStatus,
  todayISO,
  toISODate,
} from '@/lib/domain'
import {
  productivityTasksCollection,
  upsertProductivityTaskClient,
  deleteProductivityTaskClient,
  getTasksForDate,
} from '@/lib/daily'

export const Route = createFileRoute('/kanban')({
  component: KanbanBoard,
})

type ColumnId = 'inbox' | 'today' | 'family' | 'workout' | 'eat' | 'money' | 'doing' | 'done'

const KANBAN_COLUMNS: { id: ColumnId; label: string; icon: LucideIcon }[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'family', label: 'Family', icon: Users },
  { id: 'workout', label: 'Workout', icon: Dumbbell },
  { id: 'eat', label: 'Eat Healthy', icon: Salad },
  { id: 'money', label: 'Money', icon: Wallet },
  { id: 'doing', label: 'Doing', icon: Loader },
  { id: 'done', label: 'Done', icon: CheckCircle2 },
]

function KanbanBoard() {
  const today = todayISO()
  const [selectedDate, setSelectedDate] = useState<ISODate>(today)
  const isToday = selectedDate === today
  const dateInputRef = useRef<HTMLInputElement>(null)
  const dateLabel = new Date(selectedDate + 'T00:00:00').toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  function changeDate(delta: number) {
    const d = new Date(selectedDate + 'T00:00:00')
    d.setDate(d.getDate() + delta)
    setSelectedDate(toISODate(d))
  }

  const [taskInput, setTaskInput] = useState('')
  const [quickCategory, setQuickCategory] = useState<ColumnId | ''>('')
  const [tasksVersion, setTasksVersion] = useState(0)
  const [_isLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Subscribe for reactivity
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1))
    return () => sub.unsubscribe()
  }, [])

  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion])

  const tasksByColumn = useMemo(() => {
    const map: Record<ColumnId, ProductivityTask[]> = {
      inbox: [], today: [], family: [], workout: [], eat: [], money: [], doing: [], done: []
    }
    for (const t of tasks) {
      if (t.deletedAt) continue
      let col = (t.column as ColumnId) || (t.done ? 'done' : (t.date === selectedDate ? 'today' : 'inbox'))
      if (!map[col as ColumnId]) col = 'inbox'
      map[col as ColumnId].push(t)
    }
    return map
  }, [tasks, selectedDate])

  // No need to reload on date for now - client collection + getTasksForDate handles it
  // (data persists via the daily aggregate on changes)

  async function persistTasks(date: ISODate) {
    setSyncing(true)
    try {
      const current = getTasksForDate(date)
      await saveProductivityTasksForDay({ data: { date, tasks: current } })
    } catch (e) {
      console.error(e)
    } finally {
      setSyncing(false)
    }
  }

  async function handleQuickAdd(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!isToday || !taskInput.trim()) return
    const col = quickCategory || 'inbox'
    const proj = quickCategory && ['family','workout','eat','money'].includes(quickCategory) ? quickCategory : undefined
    const newTask = createProductivityTask({
      text: taskInput.trim(),
      date: selectedDate,
      column: col,
      project: proj,
      source: 'daily',
    })
    upsertProductivityTaskClient(newTask)
    setTaskInput('')
    setQuickCategory('')
    await persistTasks(selectedDate)
  }

  async function moveTaskToColumn(id: string, newColumn: ColumnId) {
    if (!isToday) return
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined
    if (!existing) return
    let updated: ProductivityTask = { ...existing, column: newColumn, updatedAt: Date.now() }
    if (newColumn === 'done' && !existing.done) {
      updated = updateTaskStatus(updated, 'done')
      updated.column = 'done'
    } else if (newColumn !== 'done' && existing.done) {
      updated = updateTaskStatus(updated, 'pending')
      updated.column = newColumn
    } else if (newColumn === 'doing') {
      updated.status = 'in_progress'
    }
    upsertProductivityTaskClient(updated)
    await persistTasks(selectedDate)
  }

  async function toggleTaskDone(id: string) {
    if (!isToday) return
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined
    if (!existing) return
    const nextStatus = existing.done ? 'pending' : 'done'
    let updated = updateTaskStatus(existing, nextStatus)
    updated.column = nextStatus === 'done' ? 'done' : (existing.column === 'done' ? 'today' : existing.column || 'today')
    upsertProductivityTaskClient(updated)
    await persistTasks(selectedDate)
  }

  async function deleteTask(id: string) {
    if (!isToday) return
    deleteProductivityTaskClient(id)
    await persistTasks(selectedDate)
  }

  function cycleToColumn(current: string | undefined, direction: 1 | -1): ColumnId {
    const idx = KANBAN_COLUMNS.findIndex(c => c.id === (current || 'today'))
    const nextIdx = (idx + direction + KANBAN_COLUMNS.length) % KANBAN_COLUMNS.length
    return KANBAN_COLUMNS[nextIdx].id
  }

  function handleDragStart(e: React.DragEvent, id: string) {
    e.dataTransfer.setData('text/plain', id)
  }
  function _handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }
  async function handleDrop(e: React.DragEvent, columnId: ColumnId) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id && isToday) await moveTaskToColumn(id, columnId)
  }

  // Simple reminders
  const reminders = useMemo(() => {
    return tasks
      .filter(t => !t.deletedAt && !t.done && t.due)
      .sort((a,b) => (a.due||'').localeCompare(b.due||''))
  }, [tasks])

  return (
    <div className="min-h-dvh bg-background px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto w-full max-w-page">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Tasks &amp; Reminders</div>
            <div className="text-3xl font-semibold tracking-tighter">Kanban Board</div>
          </div>

          <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
            <div className="flex items-center gap-2 text-sm">
              {/* Today indicator — highlights when on the current day, jumps back otherwise */}
              <Button
                variant={isToday ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedDate(today)}
                disabled={isToday}
                className="h-8 shrink-0 gap-1.5 disabled:opacity-100"
                aria-label={isToday ? 'Showing today' : 'Go to today'}
              >
                <span
                  className={`size-1.5 rounded-full bg-current transition-opacity ${isToday ? 'opacity-100' : 'opacity-0'}`}
                />
                Today
              </Button>

              <div className="flex flex-1 items-center gap-1.5 sm:flex-none">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => changeDate(-1)}
                  aria-label="Previous day"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {/* Date label doubles as the picker trigger */}
                <div className="relative flex-1 sm:flex-none">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => dateInputRef.current?.showPicker?.()}
                    className="h-8 w-full justify-center gap-1.5 tabular-nums font-medium sm:w-auto sm:min-w-[132px]"
                    aria-label="Pick a date"
                  >
                    <CalendarDays className="size-3.5 text-muted-foreground" />
                    {dateLabel}
                  </Button>
                  <input
                    ref={dateInputRef}
                    type="date"
                    value={selectedDate}
                    onChange={e => {
                      const v = e.target.value as ISODate
                      if (v) setSelectedDate(v)
                    }}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => changeDate(1)}
                  aria-label="Next day"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            {/* Read-only indicator sits under the nav; reserved height avoids layout shift */}
            <div className="flex h-5 items-center justify-end">
              {!isToday && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Lock className="size-2.5" /> Read-only
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Quick add */}
        {isToday && (
          <Card className="mb-6">
            <CardContent className="pt-4">
              <form onSubmit={handleQuickAdd} className="space-y-2">
                <div className="flex gap-2">
                  <Input value={taskInput} onChange={e=>setTaskInput(e.target.value)} placeholder="Add task for selected day..." className="flex-1" />
                  <Button type="submit" disabled={!taskInput.trim()}>Add</Button>
                  <VoiceInput onTranscript={async (text) => {
                    // Simple voice add
                    if (text.toLowerCase().includes('add')) {
                      const newT = createProductivityTask({ text: text.replace(/add/i,'').trim(), date: selectedDate })
                      upsertProductivityTaskClient(newT)
                      await persistTasks(selectedDate)
                    }
                  }} />
                </div>
                <div className="flex flex-wrap gap-1 text-[10px]">
                  {['', 'family','workout','eat','money','today','doing'].map(cat => {
                    const label = !cat ? 'Inbox' : cat==='eat' ? 'Eat Healthy' : cat[0].toUpperCase()+cat.slice(1)
                    return <button type="button" key={cat} onClick={()=>setQuickCategory(cat as any)} className={`rounded px-2 py-0.5 border text-xs ${quickCategory===cat ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>{label}</button>
                  })}
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Reminders */}
        {reminders.length > 0 && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50/60 dark:bg-amber-950/30 p-3 text-xs">
            <div className="font-semibold mb-1 text-amber-700 dark:text-amber-400">Reminders ({reminders.length})</div>
            <div className="flex flex-wrap gap-2">
              {reminders.slice(0,6).map(r => (
                <span key={r.id} className="rounded bg-white/70 px-2 py-0.5 dark:bg-black/20">{r.due}: {r.text.slice(0,35)}</span>
              ))}
            </div>
          </div>
        )}

        {/* Full Kanban */}
        <div className="kanban-board overflow-x-auto pb-4">
          <div className="flex min-w-[980px] gap-2">
            {KANBAN_COLUMNS.map(col => {
              const colTasks = tasksByColumn[col.id] || []
              const isDone = col.id === 'done'
              return (
                <div 
                  key={col.id} 
                  className="w-56 shrink-0 rounded-xl border bg-muted/30 p-3 flex flex-col min-h-[380px]"
                  onDragOver={_handleDragOver}
                  onDrop={e => handleDrop(e, col.id)}
                >
                  <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                    <span className="flex items-center gap-1.5">
                      <col.icon className="size-4 text-muted-foreground" /> {col.label}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">{colTasks.length}</span>
                  </div>
                  <div className="flex-1 space-y-2">
                    {colTasks.map(task => {
                      const overdue = task.due && task.due < selectedDate && !isDone
                      return (
                        <div 
                          key={task.id}
                          draggable={isToday}
                          onDragStart={e => handleDragStart(e, task.id)}
                          className={`group rounded-lg border bg-background p-2.5 text-sm shadow-sm ${isDone ? 'line-through opacity-70' : ''} ${overdue ? 'border-red-400' : ''}`}
                        >
                          <div className="font-medium leading-tight pr-8">{task.text}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                            {task.project && <span className="rounded bg-muted px-1">{task.project}</span>}
                            {task.due && <span className={overdue ? 'text-red-600 font-medium' : ''}>due {task.due}</span>}
                            {task.estimatedMinutes && <span>{task.estimatedMinutes}m</span>}
                          </div>
                          {isToday && (
                            <div className="mt-1.5 flex items-center gap-0.5 opacity-70 group-hover:opacity-100">
                              <button onClick={() => moveTaskToColumn(task.id, cycleToColumn(task.column, -1))} className="rounded p-1 hover:bg-muted" aria-label="Move left" title="Move left"><ArrowLeft className="size-3.5" /></button>
                              <button onClick={() => moveTaskToColumn(task.id, cycleToColumn(task.column, 1))} className="rounded p-1 hover:bg-muted" aria-label="Move right" title="Move right"><ArrowRight className="size-3.5" /></button>
                              <button onClick={() => toggleTaskDone(task.id)} className="rounded p-1 hover:bg-muted" aria-label={isDone ? 'Mark not done' : 'Mark done'} title={isDone ? 'Undo' : 'Done'}>{isDone ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}</button>
                              <button onClick={() => {
                                const nt = prompt('Edit:', task.text)
                                if (nt) {
                                  upsertProductivityTaskClient({ ...task, text: nt })
                                  persistTasks(selectedDate)
                                }
                              }} className="rounded p-1 hover:bg-muted" aria-label="Edit" title="Edit"><Pencil className="size-3.5" /></button>
                              <button onClick={() => deleteTask(task.id)} className="ml-auto rounded p-1 text-destructive hover:bg-muted" aria-label="Delete" title="Delete"><Trash2 className="size-3.5" /></button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {colTasks.length === 0 && <div className="text-xs text-muted-foreground/60 p-2">Drop tasks here</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-3 text-xs text-muted-foreground">
          Drag cards or use arrows. Tasks are saved per day.{syncing && ' • syncing…'} Use voice on dashboard or here for quick adds.
        </div>
      </div>
    </div>
  )
}
