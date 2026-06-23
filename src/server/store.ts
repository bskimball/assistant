import type { AIInteraction, VoiceTranscript } from "@/lib/domain";
import type { SoftDeleteRecord } from "@/server/adapters/r2";

export interface DailyStore {
  get<T>(domain: string, date: string): Promise<T | null>;
  put<T>(domain: string, date: string, value: T): Promise<void>;
  key(domain: string, date: string): string;
}

export interface WeeklyStore {
  get<T>(domain: string, week: string): Promise<T | null>;
  put<T>(domain: string, week: string, value: T): Promise<void>;
  key(domain: string, week: string): string;
}

export interface RefStore {
  get<T>(name: string): Promise<T | null>;
  put<T>(name: string, value: T): Promise<void>;
  key(name: string): string;
}

export interface LogStore {
  key(domain: string, date?: string): string;
  read<T>(domain: string, date: string): Promise<T[]>;
  append(domain: string, date: string | undefined, record: unknown): Promise<void>;
}

export interface DomainStore {
  daily: DailyStore;
  weekly: WeeklyStore;
  ref: RefStore;
  log: LogStore;
  putVoiceTranscript(record: VoiceTranscript): Promise<void>;
  putAIInteraction(record: AIInteraction): Promise<void>;
  getDeletedIndex(date: string): Promise<SoftDeleteRecord[]>;
  getDeletedIndexKey(date: string): string;
  recordSoftDelete(key: string, deletedAt: number, domain?: string): Promise<void>;
  putJSON<T>(key: string, value: T): Promise<void>;
  deleteObject(key: string): Promise<void>;
  deleteDeletedIndexShard(date: string): Promise<void>;
}

function parseJsonl<T>(text: string | null): T[] {
  if (!text) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => !!x);
}

export async function getDomainStore(): Promise<DomainStore> {
  const r2 = await import("@/server/adapters/r2");

  return {
    daily: {
      key: (domain, date) => r2.getDailyKey(date, domain),
      get: <T>(domain: string, date: string) => r2.getJSON<T>(r2.getDailyKey(date, domain)),
      put: <T>(domain: string, date: string, value: T) =>
        r2.putJSON(r2.getDailyKey(date, domain), value),
    },
    weekly: {
      key: (domain, week) => r2.getWeeklyKey(week, domain),
      get: <T>(domain: string, week: string) => r2.getJSON<T>(r2.getWeeklyKey(week, domain)),
      put: <T>(domain: string, week: string, value: T) =>
        r2.putJSON(r2.getWeeklyKey(week, domain), value),
    },
    ref: {
      key: (name) => r2.getRefKey(name),
      get: <T>(name: string) => r2.getJSON<T>(r2.getRefKey(name)),
      put: <T>(name: string, value: T) => r2.putJSON(r2.getRefKey(name), value),
    },
    log: {
      key: (domain, date) => r2.getLogKey(domain, date),
      read: async <T>(domain: string, date: string) => {
        const text = await r2.getObjectText(r2.getLogKey(domain, date));
        return parseJsonl<T>(text);
      },
      append: (domain, date, record) => r2.appendLogLine(r2.getLogKey(domain, date), record),
    },
    putVoiceTranscript: r2.putVoiceTranscript,
    putAIInteraction: r2.putAIInteraction,
    getDeletedIndex: r2.getDeletedIndex,
    getDeletedIndexKey: r2.getDeletedIndexKey,
    recordSoftDelete: r2.recordSoftDelete,
    putJSON: r2.putJSON,
    deleteObject: r2.deleteObject,
    deleteDeletedIndexShard: r2.deleteDeletedIndexShard,
  };
}
