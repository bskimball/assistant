import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { VoiceInput } from "@/components/voice-input";
import { Reveal, revealDelay } from "@/components/motion";
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
} from "lucide-react";
import { saveProductivityTasksForDay } from "@/server/domain";
import type { ProductivityTask, ISODate } from "@/lib/domain";
import { createProductivityTask, updateTaskStatus, todayISO, toISODate } from "@/lib/domain";
import {
  productivityTasksCollection,
  upsertProductivityTaskClient,
  deleteProductivityTaskClient,
  getTasksForDate,
} from "@/lib/daily";

export const Route = createFileRoute("/kanban")({
  component: KanbanBoard,
});

type ColumnId = "inbox" | "today" | "family" | "workout" | "eat" | "money" | "doing" | "done";

const KANBAN_COLUMNS: { id: ColumnId; label: string; icon: LucideIcon }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "today", label: "Today", icon: CalendarDays },
  { id: "family", label: "Family", icon: Users },
  { id: "workout", label: "Workout", icon: Dumbbell },
  { id: "eat", label: "Eat Healthy", icon: Salad },
  { id: "money", label: "Money", icon: Wallet },
  { id: "doing", label: "Doing", icon: Loader },
  { id: "done", label: "Done", icon: CheckCircle2 },
];

function KanbanBoard() {
  const today = todayISO();
  const [selectedDate, setSelectedDate] = useState<ISODate>(today);
  const isToday = selectedDate === today;
  const dateInputRef = useRef<HTMLInputElement>(null);
  const dateLabel = new Date(selectedDate + "T00:00:00").toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  function changeDate(delta: number) {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    setSelectedDate(toISODate(d));
  }

  const [taskInput, setTaskInput] = useState("");
  const [quickCategory, setQuickCategory] = useState<ColumnId | "">("");
  const [quickShared, setQuickShared] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | "mine" | "shared">("all");
  const [tasksVersion, setTasksVersion] = useState(0);
  const [_isLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Visual drag state only — drop logic is unchanged.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnId | null>(null);

  // Subscribe for reactivity
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1));
    return () => sub.unsubscribe();
  }, []);

  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion]);

  const visibleTasks = useMemo(() => {
    if (scopeFilter === "mine") return tasks.filter((t) => !t.shared);
    if (scopeFilter === "shared") return tasks.filter((t) => t.shared);
    return tasks;
  }, [tasks, scopeFilter]);

  const tasksByColumn = useMemo(() => {
    const map: Record<ColumnId, ProductivityTask[]> = {
      inbox: [],
      today: [],
      family: [],
      workout: [],
      eat: [],
      money: [],
      doing: [],
      done: [],
    };
    for (const t of visibleTasks) {
      if (t.deletedAt) continue;
      let col =
        (t.column as ColumnId) || (t.done ? "done" : t.date === selectedDate ? "today" : "inbox");
      if (!map[col as ColumnId]) col = "inbox";
      map[col as ColumnId].push(t);
    }
    return map;
  }, [visibleTasks, selectedDate]);

  // No need to reload on date for now - client collection + getTasksForDate handles it
  // (data persists via the daily aggregate on changes)

  async function persistTasks(date: ISODate) {
    setSyncing(true);
    try {
      const current = getTasksForDate(date);
      await saveProductivityTasksForDay({ data: { date, tasks: current } });
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleQuickAdd(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday || !taskInput.trim()) return;
    const col = quickCategory || "inbox";
    const proj =
      quickCategory && ["family", "workout", "eat", "money"].includes(quickCategory)
        ? quickCategory
        : undefined;
    const newTask = createProductivityTask({
      text: taskInput.trim(),
      date: selectedDate,
      column: col,
      project: proj,
      source: "daily",
      shared: quickShared,
    });
    upsertProductivityTaskClient(newTask);
    setTaskInput("");
    setQuickCategory("");
    await persistTasks(selectedDate);
  }

  async function toggleTaskShared(id: string) {
    if (!isToday) return;
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined;
    if (!existing) return;
    upsertProductivityTaskClient({
      ...existing,
      shared: !existing.shared,
      updatedAt: Date.now(),
    });
    await persistTasks(selectedDate);
  }

  async function moveTaskToColumn(id: string, newColumn: ColumnId) {
    if (!isToday) return;
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined;
    if (!existing) return;
    let updated: ProductivityTask = { ...existing, column: newColumn, updatedAt: Date.now() };
    if (newColumn === "done" && !existing.done) {
      updated = updateTaskStatus(updated, "done");
      updated.column = "done";
    } else if (newColumn !== "done" && existing.done) {
      updated = updateTaskStatus(updated, "pending");
      updated.column = newColumn;
    } else if (newColumn === "doing") {
      updated.status = "in_progress";
    }
    upsertProductivityTaskClient(updated);
    await persistTasks(selectedDate);
  }

  async function toggleTaskDone(id: string) {
    if (!isToday) return;
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined;
    if (!existing) return;
    const nextStatus = existing.done ? "pending" : "done";
    let updated = updateTaskStatus(existing, nextStatus);
    updated.column =
      nextStatus === "done"
        ? "done"
        : existing.column === "done"
          ? "today"
          : existing.column || "today";
    upsertProductivityTaskClient(updated);
    await persistTasks(selectedDate);
  }

  async function deleteTask(id: string) {
    if (!isToday) return;
    deleteProductivityTaskClient(id);
    await persistTasks(selectedDate);
  }

  function cycleToColumn(current: string | undefined, direction: 1 | -1): ColumnId {
    const idx = KANBAN_COLUMNS.findIndex((c) => c.id === (current || "today"));
    const nextIdx = (idx + direction + KANBAN_COLUMNS.length) % KANBAN_COLUMNS.length;
    return KANBAN_COLUMNS[nextIdx].id;
  }

  function handleDragStart(e: React.DragEvent, id: string) {
    e.dataTransfer.setData("text/plain", id);
    setDraggingId(id);
  }
  function handleDragEnd() {
    setDraggingId(null);
    setDragOverCol(null);
  }
  function handleColumnDragOver(e: React.DragEvent, columnId: ColumnId) {
    e.preventDefault();
    if (isToday && dragOverCol !== columnId) setDragOverCol(columnId);
  }
  function handleColumnDragLeave(e: React.DragEvent, columnId: ColumnId) {
    // Ignore leave events fired when moving over the column's own children.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (dragOverCol === columnId) setDragOverCol(null);
  }
  async function handleDrop(e: React.DragEvent, columnId: ColumnId) {
    e.preventDefault();
    setDraggingId(null);
    setDragOverCol(null);
    const id = e.dataTransfer.getData("text/plain");
    if (id && isToday) await moveTaskToColumn(id, columnId);
  }

  // Simple reminders
  const reminders = useMemo(() => {
    return tasks
      .filter((t) => !t.deletedAt && !t.done && t.due)
      .sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  }, [tasks]);

  return (
    <div className="bg-background px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
      <div className="mx-auto w-full max-w-page">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs tracking-tight text-muted-foreground">
              Tasks &amp; Reminders
            </div>
            <div className="text-balance text-3xl font-semibold tracking-tighter">Kanban Board</div>
          </div>

          <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
            <div className="flex items-center gap-2 text-sm">
              {/* Today indicator — highlights when on the current day, jumps back otherwise */}
              <Button
                variant={isToday ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedDate(today)}
                disabled={isToday}
                className="h-8 shrink-0 gap-1.5 disabled:opacity-100"
                aria-label={isToday ? "Showing today" : "Go to today"}
              >
                <span
                  className={`size-1.5 rounded-full bg-current transition-opacity ${isToday ? "opacity-100" : "opacity-0"}`}
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
                    className="h-8 w-full justify-center gap-1.5 tabular-nums font-medium sm:w-auto sm:min-w-33"
                    aria-label="Pick a date"
                  >
                    <CalendarDays className="size-3.5 text-muted-foreground" />
                    {dateLabel}
                  </Button>
                  <input
                    ref={dateInputRef}
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                      const v = e.target.value as ISODate;
                      if (v) setSelectedDate(v);
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
                <Badge
                  variant="secondary"
                  className="gap-1 rounded-full text-[10px] text-muted-foreground"
                >
                  <Lock className="size-2.5" /> Read-only
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Quick add */}
        {isToday && (
          <Card className="mb-6 overflow-hidden border-primary/20 bg-card shadow-sm">
            <CardContent className="pt-4">
              <form onSubmit={handleQuickAdd} className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={taskInput}
                    onChange={(e) => setTaskInput(e.target.value)}
                    placeholder="Add task for selected day..."
                    className="flex-1"
                  />
                  <Button type="submit" disabled={!taskInput.trim()}>
                    Add
                  </Button>
                  <VoiceInput
                    onTranscript={async (text) => {
                      // Simple voice add
                      if (text.toLowerCase().includes("add")) {
                        const newT = createProductivityTask({
                          text: text.replace(/add/i, "").trim(),
                          date: selectedDate,
                        });
                        upsertProductivityTaskClient(newT);
                        await persistTasks(selectedDate);
                      }
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1 text-[10px]">
                  {["", "family", "workout", "eat", "money", "today", "doing"].map((cat) => {
                    const label = !cat
                      ? "Inbox"
                      : cat === "eat"
                        ? "Eat Healthy"
                        : cat[0].toUpperCase() + cat.slice(1);
                    return (
                      <Button
                        type="button"
                        key={cat}
                        variant={quickCategory === cat ? "default" : "outline"}
                        size="sm"
                        onClick={() => setQuickCategory(cat as any)}
                        className="h-auto px-2 py-0.5 text-xs transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                      >
                        {label}
                      </Button>
                    );
                  })}
                  {/* Personal vs. shared (household) destination for the new task */}
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={quickShared}
                    onPressedChange={(p) => setQuickShared(p)}
                    className="ml-1 h-auto gap-1 px-2 py-0.5 text-xs transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
                    title={
                      quickShared ? "New task is shared with household" : "New task is personal"
                    }
                  >
                    {quickShared ? <Users className="size-3" /> : <Lock className="size-3" />}
                    {quickShared ? "Shared" : "Personal"}
                  </Toggle>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Reminders */}
        {reminders.length > 0 && (
          <Alert className="mb-3 border-amber-500/30 bg-amber-500/10 text-xs">
            <AlertTitle className="text-amber-700 dark:text-amber-300">
              Reminders ({reminders.length})
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap gap-2">
                {reminders.slice(0, 6).map((r) => (
                  <Badge
                    key={r.id}
                    variant="secondary"
                    className="bg-background/70 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
                  >
                    {r.due}: {r.text.slice(0, 35)}
                  </Badge>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Scope filter: combine mine + shared, or focus one */}
        <div className="mb-3 flex items-center gap-1 text-xs">
          {(["all", "mine", "shared"] as const).map((f) => (
            <Button
              type="button"
              key={f}
              variant={scopeFilter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setScopeFilter(f)}
              className="h-auto gap-1 rounded-full px-2.5 py-1 capitalize transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            >
              {f === "shared" && <Users className="size-3" />}
              {f === "mine" && <Lock className="size-3" />}
              {f}
            </Button>
          ))}
        </div>

        {/* Full Kanban */}
        <div className="kanban-board overflow-x-auto pb-4">
          <div className="flex min-w-245 gap-2">
            {KANBAN_COLUMNS.map((col) => {
              const colTasks = tasksByColumn[col.id] || [];
              const isDone = col.id === "done";
              const isDropTarget = draggingId !== null && dragOverCol === col.id;
              return (
                <div
                  key={col.id}
                  className={`flex min-h-35 w-56 shrink-0 flex-col rounded-2xl p-3 ring-1 transition-[background-color,box-shadow,opacity] duration-150 ease-out ${
                    isDropTarget
                      ? "bg-primary/8 shadow-md ring-primary/30"
                      : "bg-muted/30 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-foreground/10"
                  } ${colTasks.length === 0 && !isDropTarget ? "opacity-80" : ""}`}
                  onDragOver={(e) => handleColumnDragOver(e, col.id)}
                  onDragLeave={(e) => handleColumnDragLeave(e, col.id)}
                  onDrop={(e) => handleDrop(e, col.id)}
                >
                  <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                    <span className="flex items-center gap-1.5">
                      <col.icon
                        className={`size-4 transition-colors duration-150 ${
                          isDropTarget ? "text-primary" : "text-muted-foreground"
                        }`}
                      />{" "}
                      {col.label}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
                        colTasks.length === 0
                          ? "text-muted-foreground/40"
                          : "bg-background/70 text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
                      }`}
                    >
                      {colTasks.length}
                    </span>
                  </div>
                  <div className="flex-1 space-y-2">
                    {colTasks.map((task, ti) => {
                      const overdue = task.due && task.due < selectedDate && !isDone;
                      const isDragging = draggingId === task.id;
                      const cardRing = isDragging
                        ? "ring-primary/40"
                        : overdue
                          ? "ring-destructive/40"
                          : "ring-foreground/10";
                      return (
                        <Reveal as="div" key={task.id} delay={revealDelay(ti)}>
                          <div
                            draggable={isToday}
                            onDragStart={(e) => handleDragStart(e, task.id)}
                            onDragEnd={handleDragEnd}
                            className={`group rounded-lg bg-background/70 p-2.5 text-sm shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 transition-[translate,scale,opacity,box-shadow] duration-150 ease-out ${cardRing} ${
                              isDragging
                                ? "scale-[0.98] opacity-50 shadow-md"
                                : isToday
                                  ? "cursor-grab hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing"
                                  : ""
                            } ${isDone ? `line-through ${isDragging ? "" : "opacity-70"}` : ""}`}
                          >
                            <div className="font-medium leading-tight pr-8">{task.text}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                              {task.shared && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 font-medium text-primary">
                                  <Users className="size-2.5" /> Shared
                                </span>
                              )}
                              {task.project && (
                                <span className="rounded bg-muted px-1">{task.project}</span>
                              )}
                              {task.due && (
                                <span
                                  className={`tabular-nums ${overdue ? "font-medium text-destructive" : ""}`}
                                >
                                  due {task.due}
                                </span>
                              )}
                              {task.estimatedMinutes && (
                                <span className="tabular-nums">{task.estimatedMinutes}m</span>
                              )}
                            </div>
                            {isToday && (
                              <div className="mt-1.5 flex items-center gap-0.5 opacity-70 transition-opacity duration-150 group-hover:opacity-100">
                                <button
                                  onClick={() =>
                                    moveTaskToColumn(task.id, cycleToColumn(task.column, -1))
                                  }
                                  className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                  aria-label="Move left"
                                  title="Move left"
                                >
                                  <ArrowLeft className="size-3.5" />
                                </button>
                                <button
                                  onClick={() =>
                                    moveTaskToColumn(task.id, cycleToColumn(task.column, 1))
                                  }
                                  className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                  aria-label="Move right"
                                  title="Move right"
                                >
                                  <ArrowRight className="size-3.5" />
                                </button>
                                <button
                                  onClick={() => toggleTaskDone(task.id)}
                                  className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                  aria-label={isDone ? "Mark not done" : "Mark done"}
                                  title={isDone ? "Undo" : "Done"}
                                >
                                  {isDone ? (
                                    <Undo2 className="size-3.5" />
                                  ) : (
                                    <Check className="size-3.5" />
                                  )}
                                </button>
                                <button
                                  onClick={() => {
                                    const nt = prompt("Edit:", task.text);
                                    if (nt) {
                                      upsertProductivityTaskClient({ ...task, text: nt });
                                      persistTasks(selectedDate);
                                    }
                                  }}
                                  className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                  aria-label="Edit"
                                  title="Edit"
                                >
                                  <Pencil className="size-3.5" />
                                </button>
                                <button
                                  onClick={() => toggleTaskShared(task.id)}
                                  className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                  aria-label={
                                    task.shared ? "Make personal" : "Share with household"
                                  }
                                  title={task.shared ? "Make personal" : "Share with household"}
                                >
                                  {task.shared ? (
                                    <Lock className="size-3.5" />
                                  ) : (
                                    <Users className="size-3.5" />
                                  )}
                                </button>
                                <button
                                  onClick={() => deleteTask(task.id)}
                                  className="ml-auto rounded-md p-1.5 text-destructive transition-[background-color,scale] duration-150 ease-out hover:bg-destructive/10 active:scale-[0.96]"
                                  aria-label="Delete"
                                  title="Delete"
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </Reveal>
                      );
                    })}
                    {colTasks.length === 0 && (
                      <div
                        className={`rounded-lg border border-dashed px-2 py-4 text-center text-xs transition-colors duration-150 ${
                          isDropTarget
                            ? "border-primary/40 text-primary"
                            : "border-foreground/15 text-muted-foreground/60"
                        }`}
                      >
                        Drop tasks here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 text-xs text-muted-foreground">
          Drag cards or use arrows. Tasks are saved per day.{syncing && " • syncing…"} Use voice on
          dashboard or here for quick adds.
        </div>
      </div>
    </div>
  );
}
