import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { ProductivityTask, ISODate } from "@/lib/domain";
import { todayISO } from "@/lib/domain";

/**
 * Client-only TanStack DB collections for the Unified Daily Dashboard (ADR-005).
 *
 * These are hydrated from R2 daily snapshots (via server fns) for the selected date.
 * Reactivity: after voice pipeline or local edits, we upsert/delete here for instant UI,
 * then persist the mutated aggregate via save* server fns.
 *
 * Separate collections per major list; singular daily objects use React state + reload on date.
 */

export const productivityTasksCollection = createCollection(
  localOnlyCollectionOptions<ProductivityTask>({
    id: "productivity-tasks",
    getKey: (t) => t.id,
  }),
);

export function hydrateProductivityTasks(tasks: ProductivityTask[]) {
  const currentIds = Array.from(productivityTasksCollection.state.keys());
  if (currentIds.length) {
    productivityTasksCollection.delete(currentIds);
  }
  if (tasks.length) {
    productivityTasksCollection.insert(tasks);
  }
}

export function upsertProductivityTaskClient(task: ProductivityTask) {
  if (productivityTasksCollection.state.has(task.id)) {
    productivityTasksCollection.update(task.id, (draft) => {
      Object.assign(draft, task);
    });
  } else {
    productivityTasksCollection.insert(task);
  }
}

export function deleteProductivityTaskClient(id: string) {
  productivityTasksCollection.delete(id);
}

/** Return tasks for a specific date (caller filters view) */
export function getTasksForDate(date: ISODate): ProductivityTask[] {
  return Array.from(productivityTasksCollection.state.values()).filter(
    (t) => t.date === date && !t.deletedAt,
  ) as ProductivityTask[];
}

/**
 * For nutrition we keep a simple last-loaded snapshot holder (no need for collection as singular).
 * The dashboard will manage DailyNutrition via state + manual refetch/optimistic.
 * Same for plan / focus.
 *
 * Recent activity is loaded as plain arrays (small).
 */

export function todayKey(): ISODate {
  return todayISO();
}
