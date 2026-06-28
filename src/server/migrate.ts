/**
 * Transitional data migration: Brian's finance → shared household scope (ADR-017).
 *
 * Before multi-user scoping, all data lived under `assistant/brian/...`. Finance
 * is now shared, so Brian's existing finance collections must move to
 * `assistant/household/...`. Health/tasks/profile stay personal (already under
 * Brian's scope, which is unchanged).
 *
 * Two entry points, both idempotent:
 * - `ensureHouseholdFinanceMigrated()` runs automatically (memoized) the first
 *   time shared finance is read, so neither member ever sees a blank finance
 *   hub. Best-effort: failures never block a read.
 * - `migrateFinanceToHousehold` is the explicit, Brian-only server fn behind
 *   `/admin/migrate` for a manual/forced run.
 *
 * Once both members have loaded finance at least once, this module is dormant
 * and can be removed along with the `/admin/migrate` route.
 */

import { createServerFn } from "@tanstack/react-start";
import { HOUSEHOLD_ID } from "@/lib/scope";

const SOURCE_SCOPE = "brian";
const FINANCE_REF_FILES = [
  "transactions.json",
  "budget.json",
  "subscriptions.json",
  "category-rules.json",
];

export interface MigrationResult {
  migrated: boolean;
  copied: number;
  reason?: string;
}

/**
 * Copy Brian's finance collections + daily snapshots into the household scope.
 * Scope-independent (fixed source/destination), so it's safe to call regardless
 * of who is signed in. Idempotent: no-op if the household already has a ledger.
 */
export async function migrateFinanceToHouseholdImpl(): Promise<MigrationResult> {
  const r2 = await import("@/server/adapters/r2");

  // Idempotency guard: bail if the household already has finance data.
  const already = await r2.getJSON(r2.getRefKey("transactions.json", HOUSEHOLD_ID));
  if (already) return { migrated: false, copied: 0, reason: "already-migrated" };

  let copied = 0;

  // Ref collections (transactions / budget / subscriptions / category rules).
  for (const file of FINANCE_REF_FILES) {
    const value = await r2.getJSON(r2.getRefKey(file, SOURCE_SCOPE));
    if (value != null) {
      await r2.putJSON(r2.getRefKey(file, HOUSEHOLD_ID), value);
      copied++;
    }
  }

  // Daily finance snapshots (one object per date).
  const prefix = `${r2.getUserPrefix(SOURCE_SCOPE)}/daily-finance/`;
  const keys = await r2.listKeys(prefix);
  for (const key of keys) {
    const date = key.match(/\/daily-finance\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
    if (!date) continue;
    const value = await r2.getJSON(r2.getDailyKey(date, "daily-finance", SOURCE_SCOPE));
    if (value != null) {
      await r2.putJSON(r2.getDailyKey(date, "daily-finance", HOUSEHOLD_ID), value);
      copied++;
    }
  }

  return { migrated: true, copied };
}

// Memo so the (cheap) guard check only runs once per isolate after success.
let _migrationChecked = false;

/**
 * Lazily migrate Brian's finance to the household scope on first shared-finance
 * read. Best-effort and non-throwing so it never breaks a finance load.
 */
export async function ensureHouseholdFinanceMigrated(): Promise<void> {
  if (_migrationChecked) return;
  try {
    await migrateFinanceToHouseholdImpl();
    _migrationChecked = true;
  } catch {
    // Leave unmemoized so a later request can retry; never block the read.
  }
}

export const migrateFinanceToHousehold = createServerFn({ method: "POST" }).handler(
  async (ctx: any): Promise<MigrationResult> => {
    const { requireAuthSession } = await import("@/lib/auth");
    const { resolveUserScope } = await import("@/lib/scope");
    const session = await requireAuthSession(ctx?.request);
    // Only Brian (whose `assistant/brian/*` data is the source) may force this.
    if (session && resolveUserScope(session.user?.email) !== SOURCE_SCOPE) {
      return { migrated: false, copied: 0, reason: "not-authorized" };
    }
    const result = await migrateFinanceToHouseholdImpl();
    if (result.migrated) _migrationChecked = true;
    return result;
  },
);
