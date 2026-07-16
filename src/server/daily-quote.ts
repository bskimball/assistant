/**
 * Route-facing server function for the AI daily quote.
 * Implementation lives in daily-quote-impl.ts; auth gate matches coach.ts.
 */

import { createServerFn } from "@tanstack/react-start";
import type { ISODate } from "@/lib/domain";
import { requireAuthSession } from "@/lib/auth";
import { generateDailyQuoteImpl, type DailyQuoteResult } from "@/server/daily-quote-impl";

export type { DailyQuoteResult };

export const generateDailyQuote = createServerFn({ method: "POST" })
  .validator((data: { date?: ISODate; force?: boolean }) => data ?? {})
  .handler(async ({ data }): Promise<DailyQuoteResult> => {
    await requireAuthSession();
    return generateDailyQuoteImpl(data ?? {});
  });
