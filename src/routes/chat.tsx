/**
 * Coach chat (ADR-018).
 *
 * A streaming conversation with Grok that reasons over the member's recorded
 * data and proposes one-tap actions. The transport is our own SSE envelope
 * (see `src/server/chat.ts`): the `chatStream` server fn returns a raw
 * `text/event-stream` Response, which the TanStack Start client hands back
 * untouched (x-tss-raw), so `useChatStream` reads `response.body` directly.
 *
 * Persistence (ADR-018): each conversation is saved to the per-user store after
 * every completed turn, so the transcript survives navigation/reloads and past
 * chats are browsable. A module-level `cache` mirrors the active conversation
 * and the history list so returning to /chat is instant (no refetch flash);
 * the store is the durable backing read on a fresh page load.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal, revealDelay } from "@/components/motion";
import { formatDistanceToNow } from "date-fns";
import {
  Sparkles,
  Send,
  Square,
  Check,
  X,
  Utensils,
  Droplet,
  ListTodo,
  CircleCheck,
  Plus,
  History,
  Trash2,
  Brain,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { newId, todayISO } from "@/lib/domain";
import type { ChatConversationSummary, ChatMessageRecord } from "@/lib/domain";
import { upsertConversation } from "@/lib/chat";
import {
  chatStream,
  applyChatAction,
  loadChatHistory,
  loadChatConversation,
  saveChatConversation,
  deleteChatConversation,
  type ChatActionName,
  type ProposedAction,
} from "@/server/chat";

export const Route = createFileRoute("/chat")({ component: ChatPage });

/* ============================================================
   Types
   ============================================================ */

// "auto" — a memory write (ADR-020) that was applied without an Apply button and
// renders as a subtle inline chip instead of an action card.
type ActionStatus = "pending" | "applied" | "dismissed" | "auto";

/** The three memory action names auto-apply client-side (ADR-020). */
const MEMORY_ACTION_NAMES: ReadonlySet<ChatActionName> = new Set([
  "save_memory",
  "update_memory",
  "forget_memory",
]);

interface UIAction extends ProposedAction {
  status: ActionStatus;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  actions: UIAction[];
  /** assistant message still receiving stream chunks */
  streaming?: boolean;
}

interface SSEFrame {
  type: "delta" | "action" | "done" | "error";
  text?: string;
  message?: string;
  id?: string;
  name?: ChatActionName;
  args?: Record<string, unknown>;
}

/* ============================================================
   Session cache — survives route unmount so navigation is instant.
   Reset only on a full page reload (module re-evaluation).
   ============================================================ */

interface ChatCache {
  loaded: boolean;
  activeId: string | null;
  messages: UIMessage[];
  summaries: ChatConversationSummary[];
}

const cache: ChatCache = {
  loaded: false,
  activeId: null,
  messages: [],
  summaries: [],
};

function toRecords(messages: UIMessage[]): ChatMessageRecord[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));
}

function fromRecords(records: ChatMessageRecord[]): UIMessage[] {
  return records.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt,
    actions: [],
  }));
}

/* ============================================================
   useChatStream — owned streaming chat state + persistence
   ============================================================ */

function useChatStream(date: string) {
  const [messages, setMessages] = useState<UIMessage[]>(() => cache.messages);
  const [summaries, setSummaries] = useState<ChatConversationSummary[]>(() => cache.summaries);
  const [activeId, setActiveIdState] = useState<string | null>(() => cache.activeId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistTick, setPersistTick] = useState(0);

  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const stoppedRef = useRef(false);
  const activeIdRef = useRef<string | null>(cache.activeId);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Mirror state into the session cache so a remount restores instantly.
  useEffect(() => {
    cache.messages = messages;
  }, [messages]);
  useEffect(() => {
    cache.summaries = summaries;
  }, [summaries]);

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    cache.activeId = id;
    setActiveIdState(id);
  }, []);

  const patch = useCallback((id: string, fn: (m: UIMessage) => UIMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  // Persist the active conversation after each completed turn (tick-driven so we
  // read the freshest messages via the ref, not on every streamed token).
  const persist = useCallback(async (msgs: UIMessage[], id: string) => {
    const records = toRecords(msgs);
    if (records.length === 0) return;
    try {
      const { summary } = await saveChatConversation({
        data: { id, messages: records },
      });
      setSummaries((prev) => upsertConversation(prev, summary));
    } catch (e) {
      console.warn("[chat] persist failed", e);
    }
  }, []);

  useEffect(() => {
    if (persistTick === 0) return;
    const id = activeIdRef.current;
    if (id) void persist(messagesRef.current, id);
  }, [persistTick, persist]);

  // On first mount of the session, load history and restore the most recent
  // conversation (unless this session already has an active transcript cached).
  useEffect(() => {
    if (cache.loaded) return;
    cache.loaded = true;
    (async () => {
      try {
        const { conversations } = await loadChatHistory();
        setSummaries(conversations);
        if (messagesRef.current.length === 0 && conversations.length > 0) {
          const full = await loadChatConversation({
            data: { id: conversations[0].id },
          });
          if (full && messagesRef.current.length === 0) {
            setActiveId(full.id);
            setMessages(fromRecords(full.messages));
          }
        }
      } catch {
        // No history yet / not reachable — empty state is fine.
      }
    })();
  }, [setActiveId]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    readerRef.current?.cancel().catch(() => {});
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;
      setError(null);
      stoppedRef.current = false;

      // Start a new conversation id on the first message of a fresh chat.
      let id = activeIdRef.current;
      if (!id) {
        id = newId("conv");
        setActiveId(id);
      }

      const now = Date.now();
      const userMsg: UIMessage = {
        id: newId("msg"),
        role: "user",
        content: trimmed,
        createdAt: now,
        actions: [],
      };
      const assistantId = newId("msg");
      const assistantMsg: UIMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: now + 1,
        actions: [],
        streaming: true,
      };

      // Snapshot the history we send (exclude the just-added empty assistant turn).
      const history = [...messagesRef.current, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);

      try {
        const res = (await chatStream({
          data: { messages: history, date },
        })) as unknown as Response;
        if (!res.body) throw new Error("No response stream");

        const reader = res.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || stoppedRef.current) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep).trim();
            buffer = buffer.slice(sep + 2);
            if (!raw.startsWith("data:")) continue;
            let frame: SSEFrame;
            try {
              frame = JSON.parse(raw.slice(5).trim());
            } catch {
              continue;
            }
            if (frame.type === "delta" && frame.text) {
              patch(assistantId, (m) => ({
                ...m,
                content: m.content + frame.text,
              }));
            } else if (frame.type === "action" && frame.name) {
              const isMemory = MEMORY_ACTION_NAMES.has(frame.name);
              const action: UIAction = {
                id: frame.id || newId("act"),
                name: frame.name,
                args: frame.args || {},
                // Memory writes auto-apply (no Apply button) and render as a chip.
                status: isMemory ? "auto" : "pending",
              };
              patch(assistantId, (m) => ({
                ...m,
                actions: [...m.actions, action],
              }));
              // Fire-and-forget the memory write; the chip already reflects it, and
              // memory is low-stakes so we tolerate errors silently (ADR-020).
              if (isMemory) {
                void applyChatAction({
                  data: { name: action.name, args: action.args },
                }).catch((e) => console.warn("[chat] memory apply failed", e));
              }
            } else if (frame.type === "error") {
              setError(frame.message || "Something went wrong.");
            }
          }
        }
      } catch (e) {
        setError("Couldn't reach the coach. Please try again.");
        console.warn("[chat] send failed", e);
      } finally {
        readerRef.current = null;
        patch(assistantId, (m) => ({ ...m, streaming: false }));
        setIsLoading(false);
        setPersistTick((t) => t + 1);
      }
    },
    [date, isLoading, patch, setActiveId],
  );

  const applyAction = useCallback(
    async (messageId: string, action: UIAction) => {
      // Optimistically lock the buttons.
      patch(messageId, (m) => ({
        ...m,
        actions: m.actions.map((a) => (a.id === action.id ? { ...a, status: "applied" } : a)),
      }));
      try {
        const result = await applyChatAction({
          data: { name: action.name, args: action.args },
        });
        setMessages((prev) => [
          ...prev,
          {
            id: newId("msg"),
            role: "assistant",
            content: result.ok ? `✓ ${result.message}` : `Couldn't do that: ${result.message}`,
            createdAt: Date.now(),
            actions: [],
          },
        ]);
        if (!result.ok) {
          patch(messageId, (m) => ({
            ...m,
            actions: m.actions.map((a) => (a.id === action.id ? { ...a, status: "pending" } : a)),
          }));
        }
        setPersistTick((t) => t + 1);
      } catch {
        patch(messageId, (m) => ({
          ...m,
          actions: m.actions.map((a) => (a.id === action.id ? { ...a, status: "pending" } : a)),
        }));
        setError("Couldn't apply that action.");
      }
    },
    [patch],
  );

  const dismissAction = useCallback(
    (messageId: string, actionId: string) => {
      patch(messageId, (m) => ({
        ...m,
        actions: m.actions.map((a) => (a.id === actionId ? { ...a, status: "dismissed" } : a)),
      }));
    },
    [patch],
  );

  const newChat = useCallback(() => {
    stop();
    setActiveId(null);
    setMessages([]);
    setError(null);
  }, [stop, setActiveId]);

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      stop();
      setError(null);
      try {
        const full = await loadChatConversation({ data: { id } });
        if (full) {
          setActiveId(id);
          setMessages(fromRecords(full.messages));
        }
      } catch {
        setError("Couldn't open that conversation.");
      }
    },
    [stop, setActiveId],
  );

  const removeConversation = useCallback(
    async (id: string) => {
      setSummaries((prev) => prev.filter((s) => s.id !== id));
      if (id === activeIdRef.current) {
        setActiveId(null);
        setMessages([]);
      }
      try {
        await deleteChatConversation({ data: { id } });
      } catch {
        // Best-effort; the summary is already gone from the list.
      }
    },
    [setActiveId],
  );

  return {
    messages,
    summaries,
    activeId,
    isLoading,
    error,
    send,
    stop,
    applyAction,
    dismissAction,
    newChat,
    selectConversation,
    removeConversation,
  };
}

/* ============================================================
   UI
   ============================================================ */

const SUGGESTIONS = [
  "How's my protein trending this week?",
  "Am I on track for my savings goal?",
  "Log 40g protein",
  "Add a task to call the dentist",
];

/** House press feedback (see finance.tsx) — interruptible, specific properties only. */
const PRESS =
  "transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]";

const ACTION_META: Record<ChatActionName, { Icon: typeof Utensils; label: string }> = {
  log_meal: { Icon: Utensils, label: "Log meal" },
  log_water: { Icon: Droplet, label: "Log water" },
  add_task: { Icon: ListTodo, label: "Add task" },
  mark_task_done: { Icon: CircleCheck, label: "Complete task" },
  // Memory actions (ADR-020) — auto-applied, shown as inline chips not cards.
  save_memory: { Icon: Brain, label: "Remembered" },
  update_memory: { Icon: Brain, label: "Updated" },
  forget_memory: { Icon: Brain, label: "Forgot" },
};

function describeAction(name: ChatActionName, args: Record<string, unknown>): string {
  switch (name) {
    case "log_meal": {
      const macros = [
        args.protein ? `${args.protein}g protein` : null,
        args.calories ? `${args.calories} kcal` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `${args.description ?? "meal"}${macros ? ` — ${macros}` : ""}`;
    }
    case "log_water":
      return `${args.ounces ?? "?"} fl oz of water`;
    case "add_task":
      return String(args.text ?? "");
    case "mark_task_done":
      return `Mark "${args.text ?? ""}" complete`;
    case "save_memory":
      return `Remembered: ${args.content ?? ""}`;
    case "update_memory":
      return `Updated: ${args.content ?? ""}`;
    case "forget_memory":
      return "Forgot a memory";
  }
}

function ChatPage() {
  const date = todayISO();
  const chat = useChatStream(date);
  const { messages, isLoading, error, send } = chat;
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function submit() {
    if (!input.trim() || isLoading) return;
    send(input);
    setInput("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full flex-col px-4 pb-24 pt-6 sm:px-6 sm:pb-4">
      <div className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col">
        {/* Header — eyebrow + title, consistent with the other pages */}
        <div className="flex items-end justify-between gap-3 pb-4">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Coach</div>
            <h1 className="text-3xl font-semibold tracking-tighter">Chat</h1>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className={`gap-1.5 ${PRESS}`}
              onClick={chat.newChat}
              disabled={empty && chat.activeId === null}
            >
              <Plus className="size-4" /> <span className="hidden sm:inline">New chat</span>
            </Button>
            {/* History is a persistent sidebar on desktop; a drawer on smaller screens. */}
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className={`gap-1.5 lg:hidden ${PRESS}`}>
                  <History className="size-4" /> <span className="hidden sm:inline">History</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-sm">
                <SheetHeader className="border-b">
                  <SheetTitle className="flex items-center gap-2">
                    <History className="size-4" /> Chat history
                  </SheetTitle>
                </SheetHeader>
                <div className="p-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className={`w-full gap-1.5 ${PRESS}`}
                    onClick={() => {
                      chat.newChat();
                      setHistoryOpen(false);
                    }}
                  >
                    <Plus className="size-4" /> New chat
                  </Button>
                </div>
                <HistoryList
                  summaries={chat.summaries}
                  activeId={chat.activeId}
                  onSelect={(id) => {
                    chat.selectConversation(id);
                    setHistoryOpen(false);
                  }}
                  onDelete={chat.removeConversation}
                />
              </SheetContent>
            </Sheet>
          </div>
        </div>

        {/* Body: persistent history sidebar (desktop) + conversation */}
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 lg:block">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-card/40 shadow-sm ring-1 ring-foreground/10">
              <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <History className="size-4 text-muted-foreground" /> History
                </div>
                {chat.summaries.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="rounded-full text-xs text-muted-foreground [font-variant-numeric:tabular-nums]"
                  >
                    {chat.summaries.length}
                  </Badge>
                )}
              </div>
              <HistoryList
                summaries={chat.summaries}
                activeId={chat.activeId}
                onSelect={chat.selectConversation}
                onDelete={chat.removeConversation}
              />
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            {/* Conversation — content anchors to the bottom so a short chat sits
              just above the composer instead of leaving a tall empty gap.
              Plain overflow (not Radix ScrollArea, whose inner display:table
              wrapper defeats `min-h-full`). */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div
                className={`mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 pb-4 ${
                  empty ? "justify-center" : "justify-end"
                }`}
              >
                {empty ? (
                  <div className="mt-6 rounded-2xl border border-primary/20 bg-linear-to-br from-primary/8 via-card to-card p-6 text-center shadow-sm">
                    <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Sparkles className="size-6" />
                    </div>
                    <p className="text-balance text-sm font-medium">Your data-aware coach</p>
                    <p className="mx-auto mt-1 max-w-sm text-pretty text-sm text-muted-foreground">
                      I can see today's numbers and your 7-day trend. Try one of these:
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((s) => (
                        <Button
                          key={s}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => send(s)}
                          className={`rounded-full text-muted-foreground hover:text-foreground ${PRESS}`}
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <AnimatePresence initial={false}>
                    {messages.map((m) => (
                      <MessageBubble
                        key={m.id}
                        message={m}
                        onApply={(a) => chat.applyAction(m.id, a)}
                        onDismiss={(id) => chat.dismissAction(m.id, id)}
                      />
                    ))}
                  </AnimatePresence>
                )}
                {error && (
                  <Reveal
                    as="div"
                    y={6}
                    className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </Reveal>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            {/* Composer */}
            <div className="mx-auto w-full max-w-4xl pt-3">
              <div className="flex items-end gap-2 rounded-2xl bg-card p-2 shadow-sm ring-1 ring-foreground/10 transition-[box-shadow] duration-150 ease-out focus-within:shadow-md focus-within:ring-ring/60">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder="Message your coach…"
                  className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
                />
                {isLoading ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className={`rounded-lg ${PRESS}`}
                    onClick={chat.stop}
                    aria-label="Stop"
                  >
                    <Square className="size-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    className={`rounded-lg shadow-sm ${PRESS}`}
                    onClick={submit}
                    disabled={!input.trim()}
                    aria-label="Send"
                  >
                    <Send className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function HistoryList({
  summaries,
  activeId,
  onSelect,
  onDelete,
}: {
  summaries: ChatConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (summaries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <MessageSquare className="size-5" />
        </div>
        <p className="text-sm font-medium">No chats yet</p>
        <p className="text-xs text-muted-foreground">
          Your conversations with the coach will show up here.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Plain overflow (not Radix ScrollArea): the viewport sizes to content
          width, which would defeat `truncate` on long conversation titles. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 p-2">
          {summaries.map((s, i) => (
            <Reveal
              as="div"
              key={s.id}
              delay={revealDelay(i)}
              className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                s.id === activeId ? "border-primary/40 bg-primary/5" : "hover:bg-muted"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{s.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatDistanceToNow(s.updatedAt, { addSuffix: true })} · {s.messageCount} msg
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                aria-label="Delete conversation"
                className="shrink-0 rounded-md p-2 text-muted-foreground opacity-0 transition-[opacity,scale,background-color,color] duration-150 ease-out hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 active:scale-[0.96] group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onApply,
  onDismiss,
}: {
  message: UIMessage;
  onApply: (a: UIAction) => void;
  onDismiss: (id: string) => void;
}) {
  const isUser = message.role === "user";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10, x: isUser ? 12 : -12, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, x: 0, filter: "blur(0px)" }}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div className={`flex max-w-[85%] flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`whitespace-pre-wrap px-3.5 py-2.5 text-sm leading-relaxed [font-variant-numeric:tabular-nums] ${
            isUser
              ? "rounded-2xl rounded-br-md bg-linear-to-b from-primary to-primary/90 text-primary-foreground shadow-sm"
              : "rounded-2xl rounded-bl-md bg-card text-card-foreground shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
          }`}
        >
          {message.content}
          {message.streaming && !message.content && (
            <span className="flex items-center gap-1 py-1" aria-label="Coach is thinking">
              <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70" />
              <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:160ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:320ms]" />
            </span>
          )}
          {message.streaming && message.content && (
            <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-current align-middle" />
          )}
        </div>

        {message.actions.map((a) => (
          <ActionCard
            key={a.id}
            action={a}
            onApply={() => onApply(a)}
            onDismiss={() => onDismiss(a.id)}
          />
        ))}
      </div>
    </motion.div>
  );
}

function ActionCard({
  action,
  onApply,
  onDismiss,
}: {
  action: UIAction;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const meta = ACTION_META[action.name];
  const Icon = meta?.Icon ?? Sparkles;
  if (action.status === "dismissed") return null;

  // Auto-applied memory writes (ADR-020) render as a subtle inline chip, not a
  // card — the member always sees what was written, without an Apply step.
  if (action.status === "auto") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="flex items-center gap-1.5 rounded-full bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-foreground/10"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{describeAction(action.name, action.args)}</span>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      className="flex w-full items-center gap-3 rounded-xl bg-background/70 px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">{meta?.label ?? "Action"}</div>
        <div className="truncate text-sm">{describeAction(action.name, action.args)}</div>
      </div>
      {action.status === "applied" ? (
        <motion.span
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
          className="flex items-center gap-1 text-xs font-medium text-primary"
        >
          <Check className="size-4" /> Done
        </motion.span>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" className={`h-8 gap-1 shadow-sm ${PRESS}`} onClick={onApply}>
            <Check className="size-3.5" /> Apply
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={`size-8 ${PRESS}`}
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
    </motion.div>
  );
}
