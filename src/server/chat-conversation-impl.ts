import type { ChatConversation, ChatMessageRecord } from "@/lib/domain";
import { deriveTitle, upsertConversation } from "@/lib/chat";
import { updateChatConversationsImpl } from "@/server/domain-impl";

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 400;
const MAX_CONTENT = 4000;

export function sanitizeChatMessages(raw: unknown): ChatMessageRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (message: any) =>
        message && (message.role === "user" || message.role === "assistant") && message.content,
    )
    .slice(-MAX_MESSAGES)
    .map((message: any, index: number) => {
      const record: ChatMessageRecord = {
        id: String(message.id || `m-${index}`),
        role: message.role as ChatMessageRecord["role"],
        content: String(message.content).slice(0, MAX_CONTENT),
        createdAt: Number(message.createdAt) || Date.now(),
      };
      if (message.kind === "notice") record.kind = "notice";
      return record;
    });
}

/** CAS-upsert a bounded transcript without losing another tab's conversations. */
export async function saveChatConversationImpl(
  id: string,
  messages: ChatMessageRecord[],
): Promise<ChatConversation> {
  const now = Date.now();
  const title = deriveTitle(messages);
  const store = await updateChatConversationsImpl((conversations) => {
    const existing = conversations.find((conversation) => conversation.id === id);
    const saved: ChatConversation = {
      id,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages,
    };
    return upsertConversation(
      conversations.filter((conversation) => !conversation.deletedAt),
      saved,
    ).slice(0, MAX_CONVERSATIONS);
  });
  const saved = store.conversations.find((conversation) => conversation.id === id);
  if (!saved) throw new Error("Failed to save the conversation.");
  return saved;
}
