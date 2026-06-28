import type { AIInteraction, VoiceTranscript } from "@/lib/domain";
import type { SoftDeleteRecord } from "@/server/adapters/r2";
import { HOUSEHOLD_ID } from "@/lib/scope";

/**
 * Options controlling which data scope a store reads/writes (ADR-017).
 * - default (omitted / `shared: false`) → the current request's per-user scope
 * - `shared: true` → the shared household scope (finances, shared tasks)
 */
export interface StoreScopeOptions {
  shared?: boolean;
}

/**
 * Resolve the R2 user-prefix segment for a store request.
 *
 * Every store request first requires a scope bound by the request middleware.
 * Shared stores then use the household prefix; personal stores use the bound
 * per-user scope. This prevents direct server-function calls from reading
 * shared household data without first passing the auth/session boundary.
 *
 * `request-context` is imported dynamically (server-only) because it pulls in
 * `node:async_hooks`, which must never be bundled into client code.
 */
async function resolveScope(opts?: StoreScopeOptions): Promise<string> {
  const { getCurrentUserScope } = await import("@/server/request-context");
  const scope = getCurrentUserScope();
  if (!scope) {
    throw new Error(
      "No user scope bound for this request. Domain data access requires an " +
        "authenticated, scoped request (see ADR-017 / auth-middleware).",
    );
  }
  return opts?.shared ? HOUSEHOLD_ID : scope;
}

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

export async function getDomainStore(opts?: StoreScopeOptions): Promise<DomainStore> {
  const r2 = await import("@/server/adapters/r2");
  const scope = await resolveScope(opts);

  return {
    daily: {
      key: (domain, date) => r2.getDailyKey(date, domain, scope),
      get: <T>(domain: string, date: string) => r2.getJSON<T>(r2.getDailyKey(date, domain, scope)),
      put: <T>(domain: string, date: string, value: T) =>
        r2.putJSON(r2.getDailyKey(date, domain, scope), value),
    },
    weekly: {
      key: (domain, week) => r2.getWeeklyKey(week, domain, scope),
      get: <T>(domain: string, week: string) => r2.getJSON<T>(r2.getWeeklyKey(week, domain, scope)),
      put: <T>(domain: string, week: string, value: T) =>
        r2.putJSON(r2.getWeeklyKey(week, domain, scope), value),
    },
    ref: {
      key: (name) => r2.getRefKey(name, scope),
      get: <T>(name: string) => r2.getJSON<T>(r2.getRefKey(name, scope)),
      put: <T>(name: string, value: T) => r2.putJSON(r2.getRefKey(name, scope), value),
    },
    log: {
      key: (domain, date) => r2.getLogKey(domain, date, scope),
      read: async <T>(domain: string, date: string) => {
        const text = await r2.getObjectText(r2.getLogKey(domain, date, scope));
        return parseJsonl<T>(text);
      },
      append: (domain, date, record) => r2.appendLogLine(r2.getLogKey(domain, date, scope), record),
    },
    putVoiceTranscript: (record) => r2.putVoiceTranscript(record, scope),
    putAIInteraction: (record) => r2.putAIInteraction(record, scope),
    getDeletedIndex: (date) => r2.getDeletedIndex(date, scope),
    getDeletedIndexKey: (date) => r2.getDeletedIndexKey(date, scope),
    recordSoftDelete: (key, deletedAt, domain) =>
      r2.recordSoftDelete(key, deletedAt, domain, scope),
    putJSON: r2.putJSON,
    deleteObject: r2.deleteObject,
    deleteDeletedIndexShard: (date) => r2.deleteDeletedIndexShard(date, scope),
  };
}
