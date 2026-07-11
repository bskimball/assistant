import type { ISODate, ProductivityTask } from "@/lib/domain";
import { getDomainStore } from "@/server/store";

export type ProductivityTasksPayload = {
  tasks: ProductivityTask[];
  updatedAt: number;
};

export async function loadProductivityTasksForDayImpl(
  date: ISODate,
): Promise<ProductivityTasksPayload> {
  const [personalStore, sharedStore] = await Promise.all([
    getDomainStore(),
    getDomainStore({ shared: true }),
  ]);
  const [personal, shared] = await Promise.all([
    personalStore.daily.get<ProductivityTasksPayload>("productivity-tasks", date),
    sharedStore.daily.get<ProductivityTasksPayload>("productivity-tasks", date),
  ]);
  const tasks = [
    ...(personal?.tasks ?? []).map((t) => ({ ...t, shared: false })),
    ...(shared?.tasks ?? []).map((t) => ({ ...t, shared: true })),
  ];
  return {
    tasks,
    updatedAt: Math.max(personal?.updatedAt ?? 0, shared?.updatedAt ?? 0) || Date.now(),
  };
}

export async function saveProductivityTasksForDayImpl(data: {
  date: ISODate;
  tasks: ProductivityTask[];
}): Promise<ProductivityTasksPayload> {
  const now = Date.now();
  const personalTasks = data.tasks.filter((t) => !t.shared);
  const sharedTasks = data.tasks.filter((t) => t.shared);
  const [personalStore, sharedStore] = await Promise.all([
    getDomainStore(),
    getDomainStore({ shared: true }),
  ]);
  await Promise.all([
    personalStore.daily.put("productivity-tasks", data.date, {
      tasks: personalTasks,
      updatedAt: now,
    }),
    sharedStore.daily.put("productivity-tasks", data.date, {
      tasks: sharedTasks,
      updatedAt: now,
    }),
  ]);
  return { tasks: data.tasks, updatedAt: now };
}
