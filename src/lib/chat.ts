/**
 * Pure, client-safe helpers for coach chat persistence (ADR-018).
 *
 * Kept free of server-only imports (per ADR-015) so both the chat route and
 * the server functions can share one definition of how conversations are
 * titled, summarized, and merged.
 */

import type { ChatConversation, ChatConversationSummary, ChatMessageRecord } from "./domain";

const MAX_TITLE = 60;
const MAX_PREVIEW = 80;

/** Derive a short title from the first user message (falls back gracefully). */
export function deriveTitle(messages: ChatMessageRecord[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  const raw = (firstUser?.content ?? messages[0]?.content ?? "New chat").trim();
  const oneLine = raw.replace(/\s+/g, " ");
  return oneLine.length > MAX_TITLE ? oneLine.slice(0, MAX_TITLE - 1).trimEnd() + "…" : oneLine;
}

/** Project a conversation to its history-list summary (no transcript). */
export function toSummary(conv: ChatConversation): ChatConversationSummary {
  const last = conv.messages[conv.messages.length - 1];
  const previewRaw = (last?.content ?? "").trim().replace(/\s+/g, " ");
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    preview:
      previewRaw.length > MAX_PREVIEW ? previewRaw.slice(0, MAX_PREVIEW - 1) + "…" : previewRaw,
  };
}

/** Most-recently-updated first. */
export function sortByRecent<T extends { updatedAt: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Insert or replace a conversation by id, returning a new array sorted with the
 * most recently updated first. Used server-side to upsert into the store and
 * client-side to keep the cached summary list fresh.
 */
export function upsertConversation<T extends { id: string; updatedAt: number }>(
  list: T[],
  item: T,
): T[] {
  const without = list.filter((c) => c.id !== item.id);
  return sortByRecent([item, ...without]);
}
