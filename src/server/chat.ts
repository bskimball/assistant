/**
 * Route-facing Conversational Coach server functions (ADR-018/020).
 *
 * Every domain read occurs in a server-function handler while function
 * middleware has bound the member scope. In particular, `chatStream` builds
 * its context before it delegates to the raw Response builder; the stream
 * callback itself never accesses domain storage (ADR-017 security invariant).
 */

import { createServerFn } from "@tanstack/react-start";
import { requireAuthSession } from "@/lib/auth";
import type {
  ChatConversation,
  ChatConversationSummary,
  ChatMessageRecord,
  CoachMemory,
  ISODate,
} from "@/lib/domain";
import { todayISO } from "@/lib/domain";
import { sortByRecent, toSummary } from "@/lib/chat";
import {
  applyChatActionImpl,
  deleteCoachMemoryImpl,
  isChatActionName,
  type ChatActionName,
} from "@/server/chat-action-impl";
import { sanitizeChatMessages, saveChatConversationImpl } from "@/server/chat-conversation-impl";
import { createChatStreamResponse, type ChatTurn } from "@/server/chat-stream-impl";
import { buildUserContextBlock } from "@/server/context";
import {
  loadChatConversationsImpl,
  loadCoachMemoriesImpl,
  updateChatConversationsImpl,
} from "@/server/domain-impl";

export type { ChatTurn } from "@/server/chat-stream-impl";
export type {
  ChatActionName,
  MemoryActionName,
  VoiceChatActionName,
} from "@/server/chat-action-impl";

/** A model-proposed action surfaced to the user for one-tap approval. */
export interface ProposedAction {
  id: string;
  name: ChatActionName;
  args: Record<string, unknown>;
}

/**
 * Streams a coaching reply after assembling all scoped domain context. The
 * implementation receives only that completed context and performs no reads.
 */
export const chatStream = createServerFn({ method: "POST" })
  .validator((data: { messages: ChatTurn[]; date?: ISODate }) => data)
  .handler(async ({ data }): Promise<Response> => {
    await requireAuthSession();
    const date: ISODate = data?.date || todayISO();
    const contextBlock = await buildUserContextBlock(date);
    return createChatStreamResponse({
      contextBlock,
      date,
      turns: data?.messages || [],
    });
  });

/** Execute a user-approved action through the scoped shared write path. */
export const applyChatAction = createServerFn({ method: "POST" })
  .validator((data: { name: ChatActionName; args: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    await requireAuthSession();
    if (!isChatActionName(data?.name)) return { ok: false, message: "Unknown action." };
    return applyChatActionImpl(data.name, data?.args || {});
  });

/** List live personal memories, newest-updated first. */
export const loadCoachMemories = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ memories: CoachMemory[] }> => {
    await requireAuthSession();
    const store = await loadCoachMemoriesImpl();
    return {
      memories: store.memories
        .filter((memory) => !memory.deletedAt)
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    };
  },
);

/** Soft-delete one personal memory. */
export const deleteCoachMemory = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAuthSession();
    await deleteCoachMemoryImpl(String(data?.id || ""));
    return { ok: true };
  });

/** List history summaries without loading transcripts. */
export const loadChatHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ conversations: ChatConversationSummary[] }> => {
    await requireAuthSession();
    const store = await loadChatConversationsImpl();
    return {
      conversations: sortByRecent(
        store.conversations.filter(
          (conversation) => !conversation.deletedAt && conversation.messages.length > 0,
        ),
      ).map(toSummary),
    };
  },
);

/** Load one non-deleted personal conversation. */
export const loadChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<ChatConversation | null> => {
    await requireAuthSession();
    const store = await loadChatConversationsImpl();
    return (
      store.conversations.find(
        (conversation) => conversation.id === data?.id && !conversation.deletedAt,
      ) ?? null
    );
  });

/** CAS-upsert a bounded conversation transcript. */
export const saveChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string; messages: ChatMessageRecord[] }) => data)
  .handler(async ({ data }): Promise<{ summary: ChatConversationSummary }> => {
    await requireAuthSession();
    const id = String(data?.id || "").trim();
    const messages = sanitizeChatMessages(data?.messages);
    if (!id || messages.length === 0) {
      throw new Error("A conversation id and at least one message are required.");
    }
    return { summary: toSummary(await saveChatConversationImpl(id, messages)) };
  });

/** Soft-delete a conversation while retaining its audit trail. */
export const deleteChatConversation = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await requireAuthSession();
    const id = data?.id;
    const now = Date.now();
    await updateChatConversationsImpl((conversations) =>
      conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, deletedAt: now, updatedAt: now } : conversation,
      ),
    );
    return { ok: true };
  });
