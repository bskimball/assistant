import type { BaseEntity } from "@/lib/domain";
import { getDomainStore, type DomainStore } from "@/server/store";

type SoftDeleteRecord = Awaited<ReturnType<DomainStore["getDeletedIndex"]>>[number];

export async function recordSoftDeletedKeyImpl(
  key: string,
  deletedAt = Date.now(),
  domain?: string,
): Promise<void> {
  const store = await getDomainStore();
  await store.recordSoftDelete(key, deletedAt, domain);
}

/** Collection stores keep their entities under one of these list keys. */
type SoftDeleteContainer<T> = { items?: T[]; plans?: T[]; sessions?: T[] };

export async function softDeleteInStoreImpl<T extends BaseEntity>(
  id: string,
  loadFn: () => Promise<SoftDeleteContainer<T>>,
  saveFn: (payload: SoftDeleteContainer<T>) => Promise<unknown>,
  containerKey?: string,
  domainHint?: string,
): Promise<void> {
  const store = await loadFn();
  const items: T[] = store.items ?? store.plans ?? store.sessions ?? [];
  const now = Date.now();
  const updated = items.map((it) =>
    it.id === id ? ({ ...it, deletedAt: now, updatedAt: now } as T) : it,
  );
  if (store.plans) {
    await saveFn({ plans: updated });
  } else if (store.sessions) {
    await saveFn({ sessions: updated });
  } else {
    await saveFn({ items: updated });
  }
  if (containerKey) await recordSoftDeletedKeyImpl(containerKey, now, domainHint);
}

export async function runHardDeleteMaintenanceImpl(daysBack = 8): Promise<{
  shardsScanned: string[];
  objectsDeleted: string[];
  shardsPruned: string[];
}> {
  const store = await getDomainStore();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const shardsScanned: string[] = [];
  const objectsDeleted: string[] = [];
  const shardsPruned: string[] = [];

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const records = await store.getDeletedIndex(dateStr);
    shardsScanned.push(dateStr);

    const toDelete: SoftDeleteRecord[] = [];
    const keep: SoftDeleteRecord[] = [];
    for (const rec of records) {
      if (now - rec.deletedAt > sevenDaysMs) toDelete.push(rec);
      else keep.push(rec);
    }

    for (const rec of toDelete) {
      try {
        await store.deleteObject(rec.key);
        objectsDeleted.push(rec.key);
      } catch {
        /* ignore */
      }
    }

    const shardIsOld = now - d.getTime() > sevenDaysMs;
    if (shardIsOld && toDelete.length > 0) {
      try {
        await store.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } catch {
        /* ignore */
      }
    } else if (keep.length !== records.length) {
      if (keep.length === 0 && shardIsOld) {
        await store.deleteDeletedIndexShard(dateStr);
        shardsPruned.push(dateStr);
      } else {
        await store.putJSON(store.getDeletedIndexKey(dateStr), keep);
      }
    }
  }

  return { shardsScanned, objectsDeleted, shardsPruned };
}
