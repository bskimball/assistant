import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VoiceInput } from "@/components/voice-input";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { loadProductivityTasksForDay, saveProductivityTasksForDay } from "@/server/domain";
import type { ProductivityTask, ISODate } from "@/lib/domain";
import {
  addDaysISO,
  createProductivityTask,
  formatISODate,
  todayISO,
  updateTaskStatus,
} from "@/lib/domain";
import {
  productivityTasksCollection,
  hydrateProductivityTasks,
  upsertProductivityTaskClient,
  deleteProductivityTaskClient,
  getTasksForDate,
} from "@/lib/daily";
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BarbellIcon,
  BowlFoodIcon,
  CalendarDotsIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  LockIcon,
  PencilSimpleIcon,
  TagIcon,
  TrashIcon,
  TrayIcon,
  UsersIcon,
  WalletIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

export const Route = createFileRoute("/kanban")({
  component: KanbanBoard,
});

// Flow Board: four workflow columns only. Categories are tags (task.project),
// never columns — legacy category-valued columns map into Inbox at render time.
type ColumnId = "inbox" | "today" | "doing" | "done";

const WORKFLOW_COLUMNS: {
  id: ColumnId;
  label: string;
  icon: PhosphorIcon;
  empty: string;
}[] = [
  { id: "inbox", label: "Inbox", icon: TrayIcon, empty: "Inbox is clear." },
  { id: "today", label: "Today", icon: CalendarDotsIcon, empty: "Nothing planned yet." },
  { id: "doing", label: "Doing", icon: CircleNotchIcon, empty: "Nothing in motion." },
  { id: "done", label: "Done", icon: CheckCircleIcon, empty: "Nothing finished yet." },
];

type CategoryId = "family" | "workout" | "eat" | "money";

const CATEGORIES: { id: CategoryId; label: string; icon: PhosphorIcon }[] = [
  { id: "family", label: "Family", icon: UsersIcon },
  { id: "workout", label: "Workout", icon: BarbellIcon },
  { id: "eat", label: "Eat Healthy", icon: BowlFoodIcon },
  { id: "money", label: "Money", icon: WalletIcon },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as string[];
// Legacy column values that were really categories, not workflow states.
const LEGACY_CATEGORY_COLUMNS = ["family", "workout", "eat", "money", "personal"];

/** The workflow column a task renders in — legacy category columns fall to Inbox. */
function displayColumnOf(task: ProductivityTask): ColumnId {
  if (task.done || task.status === "done") return "done";
  const c = task.column;
  if (c === "today" || c === "doing" || c === "inbox") return c;
  return "inbox";
}

/** The category tag for a task, preferring an explicit project over a legacy column. */
function categoryOf(task: ProductivityTask): CategoryId | undefined {
  if (task.project && CATEGORY_IDS.includes(task.project)) return task.project as CategoryId;
  if (task.column && CATEGORY_IDS.includes(task.column)) return task.column as CategoryId;
  return undefined;
}

function KanbanBoard() {
  const today = todayISO();
  const [selectedDate, setSelectedDate] = useState<ISODate>(today);
  const isToday = selectedDate === today;
  const dateInputRef = useRef<HTMLInputElement>(null);
  const dateLabel = formatISODate(selectedDate, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  function changeDate(delta: number) {
    setSelectedDate(addDaysISO(selectedDate, delta));
  }

  const [taskInput, setTaskInput] = useState("");
  const [quickProject, setQuickProject] = useState<CategoryId | "">("");
  const [quickToday, setQuickToday] = useState(false);
  const [quickShared, setQuickShared] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | "mine" | "shared">("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryId | "all">("all");
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Visual drag state only — drop logic is unchanged.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnId | null>(null);

  // Subscribe for reactivity
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1));
    return () => sub.unsubscribe();
  }, []);

  // ADR-024: load durable board (today) or day archive (past) from the server
  // whenever the selected date changes. Client collection alone is not enough
  // because open tasks no longer live only in today-dated day files.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    loadProductivityTasksForDay({ data: selectedDate })
      .then((payload) => {
        if (cancelled) return;
        hydrateProductivityTasks(payload.tasks || []);
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion]);

  const visibleTasks = useMemo(() => {
    let list = tasks.filter((t) => !t.deletedAt);
    if (scopeFilter === "mine") list = list.filter((t) => !t.shared);
    else if (scopeFilter === "shared") list = list.filter((t) => t.shared);
    if (categoryFilter !== "all") list = list.filter((t) => categoryOf(t) === categoryFilter);
    return list;
  }, [tasks, scopeFilter, categoryFilter]);

  const tasksByColumn = useMemo(() => {
    const map: Record<ColumnId, ProductivityTask[]> = {
      inbox: [],
      today: [],
      doing: [],
      done: [],
    };
    for (const t of visibleTasks) {
      map[displayColumnOf(t)].push(t);
    }
    return map;
  }, [visibleTasks]);

  async function persistTasks(date: ISODate) {
    setSyncing(true);
    try {
      const current = getTasksForDate(date);
      const saved = await saveProductivityTasksForDay({
        data: { date, tasks: current },
      });
      // Re-hydrate from server so board + archive stay consistent after save.
      hydrateProductivityTasks(saved.tasks || current);
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  }

  async function handleQuickAdd(e?: React.SyntheticEvent) {
    if (e) e.preventDefault();
    if (!isToday || !taskInput.trim()) return;
    const newTask = createProductivityTask({
      text: taskInput.trim(),
      date: selectedDate,
      column: quickToday ? "today" : "inbox",
      project: quickProject || undefined,
      source: "daily",
      shared: quickShared,
    });
    upsertProductivityTaskClient(newTask);
    setTaskInput("");
    setQuickProject("");
    setQuickToday(false);
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

  async function setTaskCategory(id: string, category: CategoryId | undefined) {
    if (!isToday) return;
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined;
    if (!existing) return;
    // Normalize a legacy category-valued column into Inbox so the workflow
    // column and the (now explicit) project tag stop overlapping.
    const column =
      existing.column && LEGACY_CATEGORY_COLUMNS.includes(existing.column)
        ? "inbox"
        : existing.column;
    upsertProductivityTaskClient({
      ...existing,
      project: category || undefined,
      column,
      updatedAt: Date.now(),
    });
    await persistTasks(selectedDate);
  }

  async function moveTaskToColumn(id: string, newColumn: ColumnId) {
    if (!isToday) return;
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined;
    if (!existing) return;
    // Preserve a legacy category (held only in `column`) into the project tag
    // before the column is reassigned to a workflow state, so the tag survives.
    const preservedProject =
      existing.project ??
      (existing.column && CATEGORY_IDS.includes(existing.column) ? existing.column : undefined);
    let updated: ProductivityTask = {
      ...existing,
      project: preservedProject,
      column: newColumn,
      updatedAt: Date.now(),
    };
    if (newColumn === "done" && !existing.done) {
      updated = updateTaskStatus(updated, "done");
      updated.project = preservedProject;
      updated.column = "done";
    } else if (newColumn !== "done" && existing.done) {
      updated = updateTaskStatus(updated, "pending");
      updated.project = preservedProject;
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
    const updated = updateTaskStatus(existing, nextStatus);
    updated.column =
      nextStatus === "done"
        ? "done"
        : displayColumnOf({ ...existing, done: false, status: "pending" });
    if (updated.column === "done" && nextStatus !== "done") updated.column = "today";
    upsertProductivityTaskClient(updated);
    await persistTasks(selectedDate);
  }

  async function deleteTask(id: string) {
    if (!isToday) return;
    deleteProductivityTaskClient(id);
    await persistTasks(selectedDate);
  }

  function cycleToColumn(task: ProductivityTask, direction: 1 | -1): ColumnId {
    const current = displayColumnOf(task);
    const idx = WORKFLOW_COLUMNS.findIndex((c) => c.id === current);
    const nextIdx = (idx + direction + WORKFLOW_COLUMNS.length) % WORKFLOW_COLUMNS.length;
    return WORKFLOW_COLUMNS[nextIdx].id;
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
    <PageShell atmosphere="focus" density="dense" width="wide">
      <PageHeader
        eyebrow="Tasks & Reminders"
        title="Tasks"
        voice="Open tasks stay until done — no midnight vanishing act."
        description={isLoading ? "Loading…" : syncing ? "Saving…" : undefined}
      >
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
                <CaretLeftIcon className="size-4" weight="duotone" />
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
                  <CalendarDotsIcon className="size-3.5 text-muted-foreground" weight="duotone" />
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
                <CaretRightIcon className="size-4" weight="duotone" />
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
                <LockIcon className="size-2.5" weight="duotone" /> Read-only
              </Badge>
            )}
          </div>
        </div>
      </PageHeader>

      {/* Reminders */}
      {reminders.length > 0 && (
        <Alert className="mb-4 border-warning/30 bg-warning/10 text-xs">
          <AlertTitle className="text-warning-foreground">
            Reminders ({reminders.length})
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-wrap gap-2">
              {reminders.slice(0, 6).map((r) => (
                <Badge key={r.id} variant="secondary" className="zen-surface-nested">
                  {r.due}: {r.text.slice(0, 35)}
                </Badge>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* The whole board lives inside ONE glass zen-card. */}
      <div className="zen-card p-4 sm:p-5">
        {/* Quick-add header strip — one row: input + category chips + Today + shared + mic */}
        {isToday && (
          <form
            onSubmit={handleQuickAdd}
            className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-4"
          >
            <Input
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="Add a task…"
              className="zen-input h-9 min-w-45 flex-1"
            />
            <div className="flex flex-wrap items-center gap-1">
              {CATEGORIES.map((cat) => (
                <Toggle
                  key={cat.id}
                  variant="outline"
                  size="sm"
                  pressed={quickProject === cat.id}
                  onPressedChange={(p) => setQuickProject(p ? cat.id : "")}
                  aria-label={cat.label}
                  title={cat.label}
                  className="h-8 gap-1 px-2 text-xs transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
                >
                  <cat.icon className="size-3.5" weight="duotone" />
                  <span className="hidden sm:inline">{cat.label}</span>
                </Toggle>
              ))}
              <Toggle
                variant="outline"
                size="sm"
                pressed={quickToday}
                onPressedChange={setQuickToday}
                title="Plan this for Today (otherwise it lands in Inbox)"
                className="h-8 gap-1 px-2 text-xs transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
              >
                <CalendarDotsIcon className="size-3.5" weight="duotone" />
                Today
              </Toggle>
              <Toggle
                variant="outline"
                size="sm"
                pressed={quickShared}
                onPressedChange={setQuickShared}
                title={quickShared ? "New task is shared with household" : "New task is personal"}
                className="h-8 gap-1 px-2 text-xs transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
              >
                {quickShared ? (
                  <UsersIcon className="size-3.5" weight="duotone" />
                ) : (
                  <LockIcon className="size-3.5" weight="duotone" />
                )}
                <span className="hidden sm:inline">{quickShared ? "Shared" : "Personal"}</span>
              </Toggle>
            </div>
            <VoiceInput
              onTranscript={async (text) => {
                if (text.toLowerCase().includes("add")) {
                  const newT = createProductivityTask({
                    text: text.replace(/add/i, "").trim(),
                    date: selectedDate,
                    column: "inbox",
                  });
                  upsertProductivityTaskClient(newT);
                  await persistTasks(selectedDate);
                }
              }}
            />
            <Button type="submit" size="sm" className="h-9" disabled={!taskInput.trim()}>
              Add
            </Button>
          </form>
        )}

        {/* Controls: scope filter + category filter, one row */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4 text-xs">
          <div className="flex items-center gap-1">
            {(["all", "mine", "shared"] as const).map((f) => (
              <Button
                type="button"
                key={f}
                variant={scopeFilter === f ? "default" : "outline"}
                size="sm"
                onClick={() => setScopeFilter(f)}
                className="h-8 gap-1 rounded-full px-2.5 capitalize transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
              >
                {f === "shared" && <UsersIcon className="size-3" weight="duotone" />}
                {f === "mine" && <LockIcon className="size-3" weight="duotone" />}
                {f}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant={categoryFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setCategoryFilter("all")}
              className="h-8 gap-1 rounded-full px-2.5 transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
            >
              <TagIcon className="size-3" weight="duotone" /> All
            </Button>
            {CATEGORIES.map((cat) => (
              <Button
                type="button"
                key={cat.id}
                variant={categoryFilter === cat.id ? "default" : "outline"}
                size="sm"
                onClick={() => setCategoryFilter(cat.id)}
                className="h-8 gap-1 rounded-full px-2.5 transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
              >
                <cat.icon className="size-3" weight="duotone" /> {cat.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Four responsive workflow columns — fill the shell, no horizontal scroll. */}
        <LayoutGroup id="flow-board">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW_COLUMNS.map((col) => {
              const colTasks = tasksByColumn[col.id] || [];
              const isDone = col.id === "done";
              const isDropTarget = draggingId !== null && dragOverCol === col.id;
              // Done stays dimmed and collapsed: only the most recent few show
              // until expanded.
              const collapsed = isDone && !doneExpanded && colTasks.length > 3;
              const shownTasks = collapsed ? colTasks.slice(-3) : colTasks;
              return (
                <div
                  key={col.id}
                  className={`flex min-h-40 flex-col rounded-xl border p-3 transition-[background-color,box-shadow,border-color] duration-150 ease-out ${
                    isDropTarget
                      ? "border-primary/40 bg-primary/10 shadow-md"
                      : "border-border/60 bg-muted/20"
                  } ${isDone ? "opacity-90" : ""}`}
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
                        weight="duotone"
                      />
                      {col.label}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
                        colTasks.length === 0
                          ? "text-muted-foreground/40"
                          : "bg-card text-muted-foreground outline outline-1 -outline-offset-1 outline-foreground/10"
                      }`}
                    >
                      {colTasks.length}
                    </span>
                  </div>
                  <div className="flex-1 space-y-2">
                    {collapsed && (
                      <button
                        type="button"
                        onClick={() => setDoneExpanded(true)}
                        className="w-full rounded-lg border border-dashed border-foreground/15 px-2 py-1.5 text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Show {colTasks.length - 3} more finished
                      </button>
                    )}
                    <AnimatePresence initial={false} mode="popLayout">
                      {shownTasks.map((task) => {
                        const overdue = task.due && task.due < selectedDate && !isDone;
                        const isDragging = draggingId === task.id;
                        const category = categoryOf(task);
                        const categoryMeta = CATEGORIES.find((c) => c.id === category);
                        const cardRing = isDragging
                          ? "outline-primary/40"
                          : overdue
                            ? "outline-destructive/40"
                            : "outline-foreground/10";
                        return (
                          <motion.div
                            key={task.id}
                            layoutId={`flow-task-${task.id}`}
                            layout="position"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{
                              layout: { duration: 0.2, ease: "easeOut" },
                              duration: 0.2,
                              ease: "easeOut",
                            }}
                          >
                            <div
                              draggable={isToday}
                              onDragStart={(e) => handleDragStart(e, task.id)}
                              onDragEnd={handleDragEnd}
                              className={`group rounded-lg bg-card p-2.5 text-sm shadow-sm outline outline-1 -outline-offset-1 transition-[translate,scale,opacity,box-shadow] duration-150 ease-out ${cardRing} ${
                                isDragging
                                  ? "scale-[0.98] opacity-50 shadow-md"
                                  : isToday
                                    ? "cursor-grab hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing"
                                    : ""
                              } ${isDone ? `${isDragging ? "" : "opacity-70"}` : ""}`}
                            >
                              <div
                                className={`font-medium leading-tight ${isDone ? "line-through" : ""}`}
                              >
                                {task.text}
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                {isToday ? (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
                                        title="Set category"
                                      >
                                        {categoryMeta ? (
                                          <>
                                            <categoryMeta.icon
                                              className="size-2.5"
                                              weight="duotone"
                                            />
                                            {categoryMeta.label}
                                          </>
                                        ) : (
                                          <>
                                            <TagIcon className="size-2.5" weight="duotone" />
                                            Tag
                                          </>
                                        )}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent align="start" className="w-44 gap-1 p-1.5">
                                      {CATEGORIES.map((c) => (
                                        <button
                                          key={c.id}
                                          type="button"
                                          onClick={() => setTaskCategory(task.id, c.id)}
                                          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
                                            category === c.id ? "text-primary" : "text-foreground"
                                          }`}
                                        >
                                          <c.icon className="size-3.5" weight="duotone" />
                                          {c.label}
                                        </button>
                                      ))}
                                      {category && (
                                        <button
                                          type="button"
                                          onClick={() => setTaskCategory(task.id, undefined)}
                                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
                                        >
                                          <XIcon className="size-3.5" weight="duotone" />
                                          Clear tag
                                        </button>
                                      )}
                                    </PopoverContent>
                                  </Popover>
                                ) : (
                                  categoryMeta && (
                                    <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-medium">
                                      <categoryMeta.icon className="size-2.5" weight="duotone" />
                                      {categoryMeta.label}
                                    </span>
                                  )
                                )}
                                {task.shared && (
                                  <span className="inline-flex items-center gap-0.5 rounded bg-info/10 px-1 font-medium text-info">
                                    <UsersIcon className="size-2.5" weight="duotone" /> Shared
                                  </span>
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
                                      moveTaskToColumn(task.id, cycleToColumn(task, -1))
                                    }
                                    className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                    aria-label="Move to previous stage"
                                    title="Move back"
                                  >
                                    <ArrowLeftIcon className="size-3.5" weight="duotone" />
                                  </button>
                                  <button
                                    onClick={() =>
                                      moveTaskToColumn(task.id, cycleToColumn(task, 1))
                                    }
                                    className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                    aria-label="Move to next stage"
                                    title="Move forward"
                                  >
                                    <ArrowRightIcon className="size-3.5" weight="duotone" />
                                  </button>
                                  <button
                                    onClick={() => toggleTaskDone(task.id)}
                                    className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                    aria-label={isDone ? "Mark not done" : "Mark done"}
                                    title={isDone ? "Undo" : "Done"}
                                  >
                                    {isDone ? (
                                      <ArrowCounterClockwiseIcon
                                        className="size-3.5"
                                        weight="duotone"
                                      />
                                    ) : (
                                      <CheckIcon className="size-3.5" weight="duotone" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => {
                                      const nt = prompt("Edit:", task.text);
                                      if (nt) {
                                        upsertProductivityTaskClient({
                                          ...task,
                                          text: nt,
                                        });
                                        persistTasks(selectedDate);
                                      }
                                    }}
                                    className="rounded-md p-1.5 text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                    aria-label="Edit"
                                    title="Edit"
                                  >
                                    <PencilSimpleIcon className="size-3.5" weight="duotone" />
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
                                      <LockIcon className="size-3.5" weight="duotone" />
                                    ) : (
                                      <UsersIcon className="size-3.5" weight="duotone" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => deleteTask(task.id)}
                                    className="ml-auto rounded-md p-1.5 text-destructive transition-[background-color,scale] duration-150 ease-out hover:bg-destructive/10 active:scale-[0.96]"
                                    aria-label="Delete"
                                    title="Delete"
                                  >
                                    <TrashIcon className="size-3.5" weight="duotone" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                    <AnimatePresence initial={false}>
                      {colTasks.length === 0 && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                          className="flex flex-col items-center justify-center gap-2 py-8 text-center"
                        >
                          <col.icon
                            className={`size-7 transition-colors duration-150 ${
                              isDropTarget ? "text-primary/60" : "text-muted-foreground/25"
                            }`}
                            weight="duotone"
                          />
                          <p className="voice text-xs text-muted-foreground/60">{col.empty}</p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>
        </LayoutGroup>
      </div>
    </PageShell>
  );
}
