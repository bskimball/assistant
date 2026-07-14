import { describe, expect, it } from "vitest";
import type { ProductivityTask } from "@/lib/domain";
import { productivityTaskHelpers } from "@/server/productivity-impl";

const { isOpenTask, isArchivedTask, migrateOpenTasksFromDay, dedupeById } = productivityTaskHelpers;

function task(partial: Partial<ProductivityTask> & { id: string; text: string }): ProductivityTask {
  return {
    createdAt: 1,
    status: "pending",
    done: false,
    date: "2026-07-13",
    ...partial,
  };
}

describe("productivity board helpers (ADR-024)", () => {
  it("classifies open vs archived", () => {
    expect(isOpenTask(task({ id: "a", text: "open" }))).toBe(true);
    expect(isOpenTask(task({ id: "b", text: "done", done: true, status: "done" }))).toBe(false);
    expect(isArchivedTask(task({ id: "c", text: "done", done: true, status: "done" }))).toBe(true);
    expect(isArchivedTask(task({ id: "d", text: "gone", deletedAt: 9 }))).toBe(true);
    expect(isOpenTask(task({ id: "e", text: "doing", status: "in_progress" }))).toBe(true);
  });

  it("migrates open tasks from a day archive onto the board", () => {
    const board = [task({ id: "keep", text: "already on board" })];
    const day = [
      task({ id: "open-old", text: "should migrate" }),
      task({ id: "done-old", text: "finished", done: true, status: "done" }),
      task({ id: "keep", text: "duplicate open already on board" }),
    ];
    const result = migrateOpenTasksFromDay(board, day);
    expect(result.migrated).toBe(2); // open-old + keep (open on day)
    expect(result.boardTasks.map((t) => t.id).sort()).toEqual(["keep", "open-old"]);
    expect(result.dayTasks.map((t) => t.id)).toEqual(["done-old"]);
  });

  it("dedupes by id preferring later entries", () => {
    const a = task({ id: "x", text: "first" });
    const b = task({ id: "x", text: "second" });
    expect(dedupeById([a, b]).map((t) => t.text)).toEqual(["second"]);
  });
});
