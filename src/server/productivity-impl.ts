import type { ISODate, ProductivityTask } from "@/lib/domain";
import { addDaysISO, todayISO } from "@/lib/domain";
import { getDomainStore } from "@/server/store";

export type ProductivityTasksPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

/** Long-lived open board (ADR-024). Personal + household scopes. */
export const PRODUCTIVITY_BOARD_REF = "productivity-board.json";

type BoardPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

function isOpenTask(task: ProductivityTask): boolean {
  return !task.deletedAt && !task.done && task.status !== "done" && task.status !== "cancelled";
}

function isArchivedTask(task: ProductivityTask): boolean {
  return !!task.deletedAt || !!task.done || task.status === "done" || task.status === "cancelled";
}

function stampScope(tasks: ProductivityTask[] | undefined, shared: boolean): ProductivityTask[] {
  return (tasks ?? []).map((t) => ({ ...t, shared }));
}

function stripScope(tasks: ProductivityTask[]): ProductivityTask[] {
  return tasks.map(({ shared: _s, ...rest }) => rest as ProductivityTask);
}

function dedupeById(tasks: ProductivityTask[]): ProductivityTask[] {
  const map = new Map<string, ProductivityTask>();
  for (const t of tasks) map.set(t.id, t);
  return Array.from(map.values());
}

async function loadBoardScope(shared: boolean): Promise<BoardPayload> {
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  const board = await store.ref.get<BoardPayload>(PRODUCTIVITY_BOARD_REF);
  return {
    tasks: stampScope(board?.tasks, shared),
    updatedAt: board?.updatedAt ?? 0,
  };
}

async function loadDayArchiveScope(date: ISODate, shared: boolean): Promise<BoardPayload> {
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  const day = await store.daily.get<ProductivityTasksPayload>("productivity-tasks", date);
  return {
    tasks: stampScope(day?.tasks, shared),
    updatedAt: day?.updatedAt ?? 0,
  };
}

/**
 * Migrate still-open tasks out of a day archive into the durable board so they
 * stop vanishing overnight (ADR-024). Pure over current board + day lists.
 */
export function migrateOpenTasksFromDay(
  boardTasks: ProductivityTask[],
  dayTasks: ProductivityTask[],
): { boardTasks: ProductivityTask[]; dayTasks: ProductivityTask[]; migrated: number } {
  const openFromDay = dayTasks.filter(isOpenTask);
  if (openFromDay.length === 0) {
    return { boardTasks, dayTasks, migrated: 0 };
  }
  const boardIds = new Set(boardTasks.map((t) => t.id));
  const additions = openFromDay.filter((t) => !boardIds.has(t.id));
  return {
    boardTasks: dedupeById([...boardTasks, ...additions]),
    dayTasks: dayTasks.filter((t) => !isOpenTask(t)),
    migrated: openFromDay.length,
  };
}

async function migrateDayIfNeeded(date: ISODate, shared: boolean): Promise<void> {
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  const day = await store.daily.get<ProductivityTasksPayload>("productivity-tasks", date);
  if (!day?.tasks?.length) return;
  if (!day.tasks.some(isOpenTask)) return;

  const now = Date.now();
  await store.ref.update<BoardPayload>(PRODUCTIVITY_BOARD_REF, (current) => {
    const boardTasks = stampScope(current?.tasks, shared);
    const { boardTasks: nextBoard } = migrateOpenTasksFromDay(boardTasks, day.tasks);
    return { tasks: stripScope(nextBoard), updatedAt: now };
  });

  const archived = day.tasks.filter((t) => !isOpenTask(t));
  await store.daily.put("productivity-tasks", date, {
    tasks: stripScope(archived),
    updatedAt: now,
  });
}

/**
 * Load tasks visible for a day.
 * - Today: durable open board + today's archived completions.
 * - Past day: that day's archive only (history of what finished then).
 * Migrates any still-open tasks found in day archives onto the board (ADR-024).
 */
export async function loadProductivityTasksForDayImpl(
  date: ISODate,
): Promise<ProductivityTasksPayload> {
  const isToday = date === todayISO();

  // Pull open tasks out of legacy day archives onto the durable board.
  // When loading today, also sweep yesterday so overnight rollover is automatic
  // without requiring the user to open the prior day first.
  const migrateDates = isToday ? [date, addDaysISO(date, -1)] : [date];
  await Promise.all(
    migrateDates.flatMap((d) => [migrateDayIfNeeded(d, false), migrateDayIfNeeded(d, true)]),
  );

  const [personalBoard, sharedBoard, personalDay, sharedDay] = await Promise.all([
    loadBoardScope(false),
    loadBoardScope(true),
    loadDayArchiveScope(date, false),
    loadDayArchiveScope(date, true),
  ]);

  const boardOpen = [...personalBoard.tasks, ...sharedBoard.tasks].filter(isOpenTask);
  const dayArchive = [...personalDay.tasks, ...sharedDay.tasks].filter(isArchivedTask);

  // Today: open board + today's archive. Past: archive only (read-only history).
  // Also include any non-open legacy rows still on a past day file.
  const tasks = isToday
    ? dedupeById([...boardOpen, ...dayArchive])
    : dedupeById([
        ...dayArchive,
        ...[...personalDay.tasks, ...sharedDay.tasks].filter((t) => !isOpenTask(t)),
      ]);

  return {
    tasks,
    updatedAt:
      Math.max(
        personalBoard.updatedAt,
        sharedBoard.updatedAt,
        personalDay.updatedAt,
        sharedDay.updatedAt,
      ) || Date.now(),
  };
}

/**
 * Persist a day's task payload.
 * Open tasks become the durable board snapshot for each scope; archived tasks
 * for `date` replace that day's archive. Open tasks are not stored in day
 * archives (ADR-024).
 *
 * Client contract (unchanged): payload is the full visible set after the edit
 * (open board tasks + known archive rows for the day). Personal open board is
 * replaced by the payload's open personal tasks. Shared open board is replaced
 * by the payload's open shared tasks (same last-writer model as the old day
 * files; CAS retries avoid lost updates from concurrent etag conflicts).
 */
export async function saveProductivityTasksForDayImpl(data: {
  date: ISODate;
  tasks: ProductivityTask[];
}): Promise<ProductivityTasksPayload> {
  const now = Date.now();
  // Soft-deleted rows leave the board and are recorded on the day archive so
  // the 7-day hard-delete worker still has a trail if needed.
  const openPersonal = data.tasks.filter((t) => isOpenTask(t) && !t.shared);
  const openShared = data.tasks.filter((t) => isOpenTask(t) && t.shared);
  const archived = data.tasks
    .filter((t) => isArchivedTask(t) || !!t.deletedAt)
    .map((t) => (t.date === data.date ? t : { ...t, date: data.date, updatedAt: now }));
  const archivedIds = new Set(archived.map((t) => t.id));

  // Today: client payload is the full visible set → replace board open tasks.
  // Other days (voice "tomorrow", coach schedule): merge open tasks onto the
  // board without wiping unrelated open work, and drop any archived ids.
  const isToday = data.date === todayISO();

  await Promise.all([
    isToday
      ? replaceBoardScope(openPersonal, false, now)
      : mergeBoardScope(openPersonal, archivedIds, false, now),
    isToday
      ? replaceBoardScope(openShared, true, now)
      : mergeBoardScope(openShared, archivedIds, true, now),
    writeDayArchive(
      data.date,
      archived.filter((t) => !t.shared),
      false,
      now,
    ),
    writeDayArchive(
      data.date,
      archived.filter((t) => t.shared),
      true,
      now,
    ),
  ]);

  return loadProductivityTasksForDayImpl(data.date);
}

async function replaceBoardScope(
  openTasks: ProductivityTask[],
  shared: boolean,
  now: number,
): Promise<void> {
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  await store.ref.update<BoardPayload>(PRODUCTIVITY_BOARD_REF, () => ({
    tasks: stripScope(openTasks),
    updatedAt: now,
  }));
}

/** Upsert open tasks and remove archived ids without clearing the rest of the board. */
async function mergeBoardScope(
  openTasks: ProductivityTask[],
  removeIds: Set<string>,
  shared: boolean,
  now: number,
): Promise<void> {
  if (openTasks.length === 0 && removeIds.size === 0) return;
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  const incomingIds = new Set(openTasks.map((t) => t.id));
  await store.ref.update<BoardPayload>(PRODUCTIVITY_BOARD_REF, (current) => {
    const kept = (current?.tasks ?? []).filter(
      (t) => !incomingIds.has(t.id) && !removeIds.has(t.id),
    );
    return {
      tasks: stripScope([...kept, ...openTasks]),
      updatedAt: now,
    };
  });
}

async function writeDayArchive(
  date: ISODate,
  tasks: ProductivityTask[],
  shared: boolean,
  now: number,
): Promise<void> {
  const store = await getDomainStore(shared ? { shared: true } : undefined);
  await store.daily.put("productivity-tasks", date, {
    tasks: stripScope(tasks),
    updatedAt: now,
  });
}

/** Pure helpers exported for unit tests */
export const productivityTaskHelpers = {
  isOpenTask,
  isArchivedTask,
  migrateOpenTasksFromDay,
  dedupeById,
};
