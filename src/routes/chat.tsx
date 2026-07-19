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
 * every completed turn, so past chats remain browsable. A module-level `cache`
 * mirrors the active conversation while the app is open, making route changes
 * instant. A fresh app load or a new local day starts with an empty chat instead
 * of automatically reopening the latest conversation.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal } from "@/components/motion";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { newId, todayISO } from "@/lib/domain";
import { getDaypart, daypartGreeting } from "@/lib/scope";
import { useSession } from "@/lib/auth-client";
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
import {
  BrainIcon,
  ChatIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  DropIcon,
  ForkKnifeIcon,
  ListChecksIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  ReceiptIcon,
  SparkleIcon,
  SquareIcon,
  TrashIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

export const Route = createFileRoute("/chat")({ component: ChatPage });

/* ============================================================
   Types
   ============================================================ */

// "auto" — a memory write (ADR-020) that was applied without an Apply button and
// renders as a subtle inline chip instead of an action card.
type ActionStatus = "pending" | "applying" | "applied" | "dismissed" | "auto";

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
  /** System confirmation from applying an action — not a coach reply. */
  kind?: "notice";
  /** assistant message still receiving stream chunks */
  streaming?: boolean;
}

/** Legacy apply-result text stored as plain assistant bubbles before `kind`. */
function isNoticeContent(content: string): boolean {
  const t = content.trim();
  return t.startsWith("✓ ") || t.startsWith("Couldn't do that:");
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
   Reset on a full page reload or when the member-local day changes.
   ============================================================ */

interface ChatCache {
  loaded: boolean;
  date: string | null;
  activeId: string | null;
  messages: UIMessage[];
  summaries: ChatConversationSummary[];
}

const cache: ChatCache = {
  loaded: false,
  date: null,
  activeId: null,
  messages: [],
  summaries: [],
};

function prepareCacheForDate(date: string): boolean {
  if (cache.date === date) return false;
  cache.date = date;
  cache.activeId = null;
  cache.messages = [];
  return true;
}

function toRecords(messages: UIMessage[]): ChatMessageRecord[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => {
      const record: ChatMessageRecord = {
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      };
      if (m.kind === "notice") record.kind = "notice";
      return record;
    });
}

function fromRecords(records: ChatMessageRecord[]): UIMessage[] {
  return records.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt,
    actions: [],
    kind:
      r.kind === "notice" || (r.role === "assistant" && isNoticeContent(r.content))
        ? "notice"
        : undefined,
  }));
}

/* ============================================================
   useChatStream — owned streaming chat state + persistence
   ============================================================ */

function useChatStream(date: string) {
  const startedFreshDay = prepareCacheForDate(date);
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

  // `useState` initializers only run on mount. If midnight is observed while
  // this route remains mounted, clear the live state as well as the cache.
  useEffect(() => {
    if (!startedFreshDay) return;
    activeIdRef.current = null;
    setActiveIdState(null);
    setMessages([]);
    setError(null);
  }, [startedFreshDay]);

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

  // Load only history summaries on a fresh app session. The transcript stays
  // empty until the member sends a message or explicitly opens a past chat.
  useEffect(() => {
    if (cache.loaded) return;
    let active = true;
    void loadChatHistory()
      .then(({ conversations }) => {
        cache.loaded = true;
        cache.summaries = conversations;
        if (active) setSummaries(conversations);
      })
      .catch(() => {
        // A later mount can retry because loaded is set only after success.
      });
    return () => {
      active = false;
    };
  }, []);

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

      // Snapshot the history we send (exclude notices + the empty assistant turn).
      const history = [...messagesRef.current, userMsg]
        .filter((m) => m.kind !== "notice")
        .map((m) => ({
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
      // Lock the buttons immediately, but don't report success until confirmed.
      patch(messageId, (m) => ({
        ...m,
        actions: m.actions.map((a) => (a.id === action.id ? { ...a, status: "applying" } : a)),
      }));
      try {
        const result = await applyChatAction({
          data: { name: action.name, args: action.args },
        });
        patch(messageId, (m) => ({
          ...m,
          actions: m.actions.map((a) =>
            a.id === action.id ? { ...a, status: result.ok ? "applied" : "pending" } : a,
          ),
        }));
        setMessages((prev) => [
          ...prev,
          {
            id: newId("msg"),
            role: "assistant",
            kind: "notice",
            content: result.ok ? `✓ ${result.message}` : `Couldn't do that: ${result.message}`,
            createdAt: Date.now(),
            actions: [],
          },
        ]);
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

const ACTION_META: Record<ChatActionName, { Icon: PhosphorIcon; label: string }> = {
  log_meal: { Icon: ForkKnifeIcon, label: "Log meal" },
  log_water: { Icon: DropIcon, label: "Log water" },
  add_task: { Icon: ListChecksIcon, label: "Add task" },
  mark_task_done: { Icon: CheckCircleIcon, label: "Complete task" },
  // Memory actions (ADR-020) — auto-applied, shown as inline chips not cards.
  save_memory: { Icon: BrainIcon, label: "Remembered" },
  update_memory: { Icon: BrainIcon, label: "Updated" },
  forget_memory: { Icon: BrainIcon, label: "Forgot" },
  restore_transaction: { Icon: ReceiptIcon, label: "Restore transaction" },
  mark_bill_paid: { Icon: ReceiptIcon, label: "Mark bill paid" },
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
    case "restore_transaction":
      return `Restore transaction ${args.transactionId ?? ""}`;
    case "mark_bill_paid":
      return `Mark ${args.name ?? "bill"} paid${args.month ? ` for ${args.month}` : ""}`;
  }
}

function ChatPage() {
  const date = todayISO();
  const chat = useChatStream(date);
  const { messages, isLoading, error, send } = chat;
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState({
    id: 0,
    message: "",
  });
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const viewport = scrollViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  useEffect(() => {
    pinnedToBottomRef.current = true;
    const viewport = scrollViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [chat.activeId]);

  function onTranscriptScroll() {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    pinnedToBottomRef.current =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
  }

  function submit() {
    if (!input.trim() || isLoading) return;
    // Sending is an explicit request to return to the live edge, even if the
    // member had scrolled up to read an older message.
    pinnedToBottomRef.current = true;
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
  const daypart = getDaypart(new Date());

  const { data: greetSession } = useSession();
  const firstName = (greetSession?.user?.name || "").trim().split(/\s+/)[0];
  const greetingLead = `${daypartGreeting(daypart)}${firstName ? `, ${firstName}` : ""}.`;

  return (
    <div
      className="zen-ambient !min-h-0 flex h-[calc(100dvh-var(--shelf-h)-var(--tabbar-h))] min-w-0 max-w-full flex-col overflow-x-hidden px-4 pt-4 sm:px-6"
      data-daypart={daypart}
      data-density="medium"
      data-atmosphere="calm"
      data-streaming={isLoading ? "true" : undefined}
    >
      <div className="relative z-10 mx-auto flex min-h-0 min-w-0 w-full max-w-4xl flex-1 flex-col overflow-x-hidden">
        {/* Header — compresses once a conversation begins so the transcript leads. */}
        <div className="flex items-end justify-between gap-3 pb-4">
          <AnimatePresence initial={false}>
            {empty && (
              <motion.div
                key="title"
                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              >
                <h1 className="greeting-display on-scene text-3xl text-foreground">Chat</h1>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className={`gap-1.5 ${PRESS}`}
              onClick={chat.newChat}
              disabled={empty && chat.activeId === null}
            >
              <PlusIcon className="size-4" weight="duotone" />{" "}
              <span className="hidden sm:inline">New chat</span>
            </Button>
            {/* History is always a drawer to keep the layout single-column and immersive. */}
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className={`gap-1.5 ${PRESS}`}>
                  <ClockCounterClockwiseIcon className="size-4" weight="duotone" />{" "}
                  <span className="hidden sm:inline">History</span>
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 border-l border-border/40 bg-popover/95 p-0 backdrop-blur-xl sm:max-w-sm"
              >
                <SheetHeader className="border-b border-border/40">
                  <SheetTitle className="flex items-center gap-2">
                    <ClockCounterClockwiseIcon className="size-4" weight="duotone" /> Chat history
                  </SheetTitle>
                </SheetHeader>
                <div className="border-b border-border/25 p-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className={`w-full gap-1.5 ${PRESS}`}
                    onClick={() => {
                      chat.newChat();
                      setHistoryOpen(false);
                    }}
                  >
                    <PlusIcon className="size-4" weight="duotone" /> New chat
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

        {/* Body: a single centered conversation column — the ambient scene shows
            through the transparent UI. */}
        <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Conversation — content anchors to the bottom so a short chat sits
              just above the composer instead of leaving a tall empty gap.
              Plain overflow (not Radix ScrollArea, whose inner display:table
              wrapper defeats `min-h-full`). */}
            <div
              ref={scrollViewportRef}
              onScroll={onTranscriptScroll}
              className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]"
            >
              <div className="relative flex min-h-full min-w-0 w-full max-w-full flex-col justify-end gap-4 overflow-x-hidden pb-4">
                <AnimatePresence initial={false}>
                  {empty && (
                    <motion.div
                      key="hero"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ duration: 0.16, ease: "easeOut" }}
                      className="absolute inset-0 flex flex-col items-center justify-center px-2 text-center"
                    >
                      <motion.div
                        animate={{ y: [0, -6, 0] }}
                        transition={{
                          duration: 5,
                          ease: "easeInOut",
                          repeat: Infinity,
                        }}
                        className="coach-orb mb-6 mt-6 size-14"
                      >
                        <div className="relative z-10 flex size-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary shadow-[0_8px_30px_-12px_var(--primary)] backdrop-blur-sm">
                          <SparkleIcon className="size-6" weight="duotone" />
                        </div>
                      </motion.div>
                      <h2 className="greeting-display on-scene text-balance text-4xl text-foreground sm:text-5xl">
                        {greetingLead}
                      </h2>
                      <p className="voice on-scene mt-3 text-pretty text-lg text-foreground/80">
                        What's on your mind?
                      </p>
                      <div className="mt-7 flex flex-wrap justify-center gap-2">
                        {SUGGESTIONS.map((s, i) => (
                          <motion.button
                            key={s}
                            type="button"
                            onClick={() => send(s)}
                            initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                            whileHover={{ y: -2 }}
                            transition={{
                              type: "spring",
                              duration: 0.35,
                              bounce: 0,
                              delay: 0.05 + i * 0.05,
                            }}
                            className={`zen-input min-h-9 rounded-full border px-4 text-sm text-foreground/80 shadow-sm hover:border-primary/30 hover:text-foreground hover:shadow-md ${PRESS}`}
                          >
                            {s}
                          </motion.button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                  {messages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      onApply={(a) => chat.applyAction(m.id, a)}
                      onDismiss={(action) => {
                        chat.dismissAction(m.id, action.id);
                        setStatusAnnouncement((current) => ({
                          id: current.id + 1,
                          message: `${ACTION_META[action.name]?.label ?? "Action"} dismissed.`,
                        }));
                      }}
                    />
                  ))}
                </AnimatePresence>
                {error && (
                  <Reveal
                    as="div"
                    y={6}
                    className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </Reveal>
                )}
                <span
                  key={statusAnnouncement.id}
                  className="sr-only"
                  role="status"
                  aria-live="polite"
                >
                  {statusAnnouncement.message}
                </span>
              </div>
            </div>

            {/* Composer — a plain shrink-0 flex child anchored at the bottom of
                the full-height column, so it's pinned to the chat viewport floor
                in every state (empty greeting included) without sticky/fixed. */}
            <div className="group/composer relative z-20 shrink-0 pb-4 pt-3">
              {/* Aurora glow — blooms softly behind the field on focus. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-6 bottom-8 top-3 rounded-2xl bg-primary/20 opacity-0 blur-2xl transition-opacity duration-300 group-focus-within/composer:opacity-100 md:bottom-6"
              />
              <div className="zen-card relative flex min-w-0 max-w-full items-end gap-2 overflow-x-hidden p-2 transition-[box-shadow] duration-150 ease-out focus-within:shadow-lg focus-within:ring-1 focus-within:ring-ring/60">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder="Message your coach…"
                  className="max-h-40 min-h-10 min-w-0 max-w-full resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                />
                {isLoading ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className={`size-10 shrink-0 rounded-2xl ${PRESS}`}
                    onClick={chat.stop}
                    aria-label="Stop"
                  >
                    <SquareIcon className="size-4" weight="duotone" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    className={`size-10 shrink-0 rounded-2xl shadow-sm ${PRESS}`}
                    onClick={submit}
                    disabled={!input.trim()}
                    aria-label="Send"
                  >
                    <PaperPlaneRightIcon className="size-4" weight="duotone" />
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
  const empty = summaries.length === 0;
  // 180ms opacity/x on insert/delete/reflow; layout carries reordering movement.
  const ITEM_TRANSITION = { duration: 0.18, ease: "easeOut" } as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Plain overflow (not Radix ScrollArea): the viewport sizes to content
          width, which would defeat `truncate` on long conversation titles. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence initial={false} mode="wait">
          {empty ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={ITEM_TRANSITION}
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ChatIcon className="size-5" weight="duotone" />
              </div>
              <p className="text-sm font-medium">No chats yet</p>
              <p className="text-xs text-muted-foreground">
                Your conversations with the coach will show up here.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={ITEM_TRANSITION}
              className="flex flex-col gap-1 p-2"
            >
              <AnimatePresence initial={false}>
                {summaries.map((s) => (
                  <motion.div
                    key={s.id}
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={ITEM_TRANSITION}
                    className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                      s.id === activeId
                        ? "border-primary/40 bg-primary/10"
                        : "border-transparent hover:bg-muted/50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(s.id)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <ChatIcon
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        weight="duotone"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{s.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatDistanceToNow(s.updatedAt, {
                            addSuffix: true,
                          })}{" "}
                          · <span className="tabular-nums">{s.messageCount}</span> msg
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      aria-label="Delete conversation"
                      className="shrink-0 rounded-md p-2 text-muted-foreground opacity-0 transition-[opacity,scale,background-color,color] duration-150 ease-out hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 active:scale-[0.96] group-hover:opacity-100"
                    >
                      <TrashIcon className="size-4" weight="duotone" />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
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
  onDismiss: (action: UIAction) => void;
}) {
  const isUser = message.role === "user";
  const isNotice = message.kind === "notice";
  const thinking = message.streaming && !message.content;

  // Apply-result confirmations are system notices, not coach speech bubbles.
  if (isNotice) {
    const ok = message.content.trim().startsWith("✓");
    const label = message.content.replace(/^✓\s*/, "").trim();
    return (
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="flex min-w-0 max-w-full justify-start overflow-x-hidden"
        role="status"
      >
        <div
          className={`inline-flex min-w-0 max-w-[min(100%,28rem)] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-sm backdrop-blur-sm ${
            ok
              ? "border-success/25 bg-success/10 text-success"
              : "border-destructive/25 bg-destructive/10 text-destructive"
          }`}
        >
          {ok ? (
            <CheckIcon className="size-3.5 shrink-0" weight="duotone" />
          ) : (
            <XIcon className="size-3.5 shrink-0" weight="duotone" />
          )}
          <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{label}</span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout={message.streaming ? false : "position"}
      initial={isUser ? false : { opacity: 0, y: 10, x: -12 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={`group/msg flex min-w-0 max-w-full items-end gap-2.5 overflow-x-hidden ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex min-w-0 max-w-[85%] flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
      >
        <div
          className={`chat-bubble min-w-0 max-w-full whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm leading-relaxed [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] ${
            isUser
              ? "chat-bubble-user relative rounded-2xl rounded-br-none bg-primary text-primary-foreground shadow-md shadow-primary/20"
              : `chat-bubble-coach zen-card rounded-2xl rounded-bl-none text-card-foreground ${
                  thinking ? "coach-thinking" : ""
                }`
          }`}
        >
          {message.content}
          {thinking && (
            <span className="flex items-center gap-1 py-1" aria-label="Coach is thinking">
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60" />
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:160ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:320ms]" />
            </span>
          )}
          {message.streaming && message.content && (
            <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-current align-middle" />
          )}
        </div>

        {/* Timestamp — revealed on hover so it's there when wanted, quiet otherwise. */}
        {!message.streaming && (
          <span
            className={`px-1 text-[10px] tabular-nums text-muted-foreground/70 opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100 ${
              isUser ? "text-right" : "text-left"
            }`}
          >
            {formatDistanceToNow(message.createdAt, { addSuffix: true })}
          </span>
        )}

        <AnimatePresence initial={false}>
          {message.actions
            .filter((a) => a.status !== "dismissed")
            .map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                onApply={() => onApply(a)}
                onDismiss={() => onDismiss(a)}
              />
            ))}
        </AnimatePresence>
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
  const Icon = meta?.Icon ?? SparkleIcon;

  // Auto-applied memory writes (ADR-020) render as a subtle inline chip, not a
  // card — the member always sees what was written, without an Apply step.
  if (action.status === "auto") {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="zen-surface-nested flex min-h-10 min-w-0 max-w-full items-center gap-1.5 overflow-x-hidden rounded-full px-3 py-2 text-xs text-muted-foreground"
      >
        <Icon className="size-3.5 shrink-0" weight="duotone" />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {describeAction(action.name, action.args)}
        </span>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="zen-surface-nested flex min-w-0 w-full max-w-full flex-wrap items-center gap-3 overflow-x-hidden px-3 py-2.5 sm:flex-nowrap"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
        <Icon className="size-4" weight="duotone" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">{meta?.label ?? "Action"}</div>
        <div className="break-words text-sm [overflow-wrap:anywhere]">
          {describeAction(action.name, action.args)}
        </div>
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {action.status === "applied" ? (
          <motion.span
            key="done"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="flex items-center gap-1 text-xs font-medium text-success"
          >
            <CheckIcon className="size-4" weight="duotone" /> Done
          </motion.span>
        ) : (
          <motion.div
            key="controls"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="ml-auto flex shrink-0 items-center gap-1.5"
          >
            <Button
              size="sm"
              className={`h-8 gap-1 shadow-sm ${PRESS}`}
              onClick={onApply}
              disabled={action.status === "applying"}
            >
              <CheckIcon className="size-3.5" weight="duotone" />
              {action.status === "applying" ? "Applying…" : "Apply"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className={`size-8 ${PRESS}`}
              onClick={onDismiss}
              disabled={action.status === "applying"}
              aria-label="Dismiss"
            >
              <XIcon className="size-4" weight="duotone" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
