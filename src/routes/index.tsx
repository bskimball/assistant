import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { VoiceInput, speakAssistant } from '@/components/VoiceInput'
import {
  processVoiceInput,
  loadDailyDashboard,
  saveProductivityTasksForDay,
  type DailyDashboardPayload,
} from '@/lib/server/domain'
import type {
  ProductivityTask,
  DailyNutrition,
  ISODate,
  DailyFocusScore,
  DailyPlan,
} from '@/lib/domain'
import {
  createProductivityTask,
  updateTaskStatus,
  todayISO,
  toISODate,
} from '@/lib/domain'
import {
  productivityTasksCollection,
  hydrateProductivityTasks,
  upsertProductivityTaskClient,
  getTasksForDate,
} from '@/lib/daily'

// Unified Daily Improvement Dashboard (ADR-005)
// Replaces previous todo-centric view. Uses daily aggregates + TanStack DB for reactivity.

type Search = { date?: string }

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): Search => {
    const raw = typeof search.date === 'string' ? search.date : undefined
    const valid = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
    return { date: valid }
  },
  component: UnifiedDailyDashboard,
})

function UnifiedDailyDashboard() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const today = todayISO()
  const selectedDate: ISODate = (search.date as ISODate) || today
  const isToday = selectedDate === today

  // Dashboard data state (ADR-005)
  const [dashboard, setDashboard] = useState<DailyDashboardPayload | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Voice state (reused from ADR-004)
  const [voiceStatus, setVoiceStatus] = useState<string>('')
  const [pendingConfirm, setPendingConfirm] = useState<{ transcript: string; intentText?: string } | null>(null)
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false)

  // Listening overlay (for persistent mic FAB)
  const [isListeningOverlay, setIsListeningOverlay] = useState(false)
  const [interim, setInterim] = useState('')
  const [listenError, setListenError] = useState<string | null>(null)

  // Local quick-add for tasks (Focus section)
  const [taskInput, setTaskInput] = useState('')

  // Subscribe to productivity collection for instant updates
  const [tasksVersion, setTasksVersion] = useState(0)
  useEffect(() => {
    const sub = productivityTasksCollection.subscribeChanges(() => setTasksVersion((v) => v + 1))
    return () => sub.unsubscribe()
  }, [])

  const tasks = useMemo(() => getTasksForDate(selectedDate), [selectedDate, tasksVersion])
  const openTasks = tasks.filter((t) => !t.done && !t.deletedAt)
  const doneTasks = tasks.filter((t) => t.done && !t.deletedAt)
  const focusProgress = tasks.length > 0 ? Math.round((doneTasks.length / tasks.length) * 100) : 0

  // Derived headline signals (no extra LLM)
  const nutrition = dashboard?.nutrition as (DailyNutrition & { updatedAt?: number }) | null
  const focusScore = (dashboard?.focus || null) as (DailyFocusScore & { updatedAt?: number }) | null
  const dailyPlan = (dashboard?.plan || null) as (DailyPlan & { updatedAt?: number }) | null

  const proteinCurrent = nutrition?.totals?.protein ?? 0
  const proteinTarget = dailyPlan?.nutritionTargets?.protein ?? 150
  const proteinPct = Math.min(100, Math.round((proteinCurrent / Math.max(1, proteinTarget)) * 100))

  const focusMinutes = focusScore?.focusMinutes ?? 0

  const latestVoiceNote = useMemo(() => {
    const acts = dashboard?.recent || { interactions: [], transcripts: [] }
    const fromAI = (acts.interactions || [])
      .map((i) => ({ t: i.timestamp, text: (i.response || '').toString().slice(0, 140) }))
    const fromVoice = (acts.transcripts || [])
      .map((v) => ({ t: v.timestamp, text: (v.transcriptText || '').slice(0, 140) }))
    const all = [...fromAI, ...fromVoice].sort((a, b) => b.t - a.t)
    return all[0]?.text || null
  }, [dashboard])

  // Date nav
  function changeDate(deltaOrDate: number | ISODate) {
    let next: ISODate
    if (typeof deltaOrDate === 'number') {
      const d = new Date(selectedDate + 'T00:00:00')
      d.setDate(d.getDate() + deltaOrDate)
      next = toISODate(d)
    } else {
      next = deltaOrDate
    }
    navigate({ search: { date: next } })
  }

  function goToday() {
    navigate({ search: {} }) // clears date param → today
  }

  // Load data for a date (snapshot + recent activity)
  async function loadForDate(date: ISODate) {
    setIsLoading(true)
    try {
      const data = await loadDailyDashboard({ data: date })
      setDashboard(data)

      // Hydrate TanStack DB collection for this day's tasks
      hydrateProductivityTasks(data.productivity?.tasks || [])
    } catch (e) {
      console.warn('[dashboard] loadDailyDashboard failed for', date, e)
      // Provide empty shell so UI renders
      setDashboard({
        date,
        nutrition: null,
        productivity: { tasks: [], updatedAt: Date.now() },
        plan: null,
        focus: null,
        recent: { interactions: [], transcripts: [] },
      })
      hydrateProductivityTasks([])
    } finally {
      setIsLoading(false)
    }
  }

  // Reload when date changes
  useEffect(() => {
    loadForDate(selectedDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate])

  // Persist current day's productivity tasks (RMW via aggregate)
  async function persistTasks(date: ISODate) {
    setSyncing(true)
    try {
      const current = getTasksForDate(date)
      await saveProductivityTasksForDay({ data: { date, tasks: current } })
    } catch (e) {
      console.error('[dashboard] Failed to persist productivity tasks', e)
    } finally {
      setSyncing(false)
    }
  }

  // Quick add task (current day only)
  async function handleQuickAdd(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!isToday || !taskInput.trim()) return
    const newTask = createProductivityTask({ text: taskInput.trim(), date: selectedDate, source: 'daily' })
    upsertProductivityTaskClient(newTask)
    setTaskInput('')
    await persistTasks(selectedDate)
  }

  // Toggle task done (current day only)
  async function toggleTaskDone(id: string) {
    if (!isToday) return
    const existing = productivityTasksCollection.state.get(id) as ProductivityTask | undefined
    if (!existing) return
    const nextStatus = existing.done ? 'pending' : 'done'
    const updated = updateTaskStatus(existing, nextStatus)
    upsertProductivityTaskClient(updated)
    await persistTasks(selectedDate)
  }

  // Voice transcript handler (ADR-004 + dashboard reactivity)
  async function handleVoiceTranscript(text: string) {
    setIsVoiceProcessing(true)
    setVoiceStatus('Processing…')
    try {
      const result = await processVoiceInput({ data: { transcriptText: text } })
      setVoiceStatus(result.spokenText || 'Done')

      // Refresh aggregates for the (possibly different) target day the voice acted on
      // For simplicity we reload the currently viewed date; voice often targets today.
      await loadForDate(selectedDate)

      if (result.success) {
        speakAssistant(result.spokenText || 'Done')
      } else if (result.intent?.requiresConfirmation) {
        setPendingConfirm({ transcript: text, intentText: result.intent.action })
        speakAssistant(result.spokenText)
      } else {
        speakAssistant(result.spokenText)
      }
    } catch (e: any) {
      const msg = 'Voice error. ' + (e?.message || '')
      setVoiceStatus(msg)
      speakAssistant('Sorry, something went wrong.')
    } finally {
      setIsVoiceProcessing(false)
      setTimeout(() => setVoiceStatus(''), 2200)
    }
  }

  async function confirmVoiceAction(confirmed: boolean) {
    if (!pendingConfirm) return
    const { transcript } = pendingConfirm
    setPendingConfirm(null)
    if (!confirmed) {
      setVoiceStatus('Cancelled')
      setTimeout(() => setVoiceStatus(''), 1200)
      return
    }
    setIsVoiceProcessing(true)
    setVoiceStatus('Executing…')
    try {
      const result = await processVoiceInput({ data: { transcriptText: transcript, forceExecute: true } })
      setVoiceStatus(result.spokenText || '')
      await loadForDate(selectedDate)
      if (result.success) speakAssistant(result.spokenText)
    } catch {
      setVoiceStatus('Confirm failed')
    } finally {
      setIsVoiceProcessing(false)
      setTimeout(() => setVoiceStatus(''), 2000)
    }
  }

  // === Persistent Mic FAB + Listening overlay (ADR-005) ===
  const isListening = isListeningOverlay

  function stopOverlayListening() {
    const rec = (window as any).__dashRec
    if (rec) {
      try { rec.onresult = null; rec.onerror = null; rec.onend = null; rec.stop() } catch {}
      ;(window as any).__dashRec = null
    }
    setInterim('')
    setIsListeningOverlay(false)
  }

  function startMainListening() {
    if (!isToday) return
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      setListenError('Voice not supported. Use Chrome/Edge.')
      return
    }
    setListenError(null)
    setInterim('')
    setIsListeningOverlay(true)

    const rec = new SR()
    ;(window as any).__dashRec = rec
    rec.continuous = false
    rec.interimResults = true
    rec.lang = 'en-US'

    rec.onresult = (event: any) => {
      let finalText = ''
      let curInterim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i]
        if (res.isFinal) finalText += res[0].transcript
        else curInterim += res[0].transcript
      }
      if (curInterim) setInterim(curInterim.trim())
      if (finalText) {
        const cleaned = finalText.trim()
        stopOverlayListening()
        handleVoiceTranscript(cleaned)
      }
    }
    rec.onerror = () => {
      stopOverlayListening()
      setListenError('No speech or recognition error.')
      setTimeout(() => setListenError(null), 1800)
    }
    rec.onend = () => {
      if (isListeningOverlay) setIsListeningOverlay(false)
      ;(window as any).__dashRec = null
    }

    try {
      rec.start()
    } catch {
      stopOverlayListening()
      setListenError('Could not start mic.')
    }
  }

  function handleFabClick() {
    if (isListening) {
      stopOverlayListening()
      return
    }
    startMainListening()
  }

  // Simple progress ring component (focus + protein)
  function ProgressRing({ value, label, sub }: { value: number; label: string; sub?: string }) {
    const pct = Math.max(0, Math.min(100, value))
    const r = 28
    const c = 2 * Math.PI * r
    const off = c * (1 - pct / 100)
    return (
      <div className="flex flex-col items-center">
        <svg width="68" height="68" className="-rotate-90">
          <circle cx="34" cy="34" r={r} stroke="currentColor" strokeOpacity={0.12} strokeWidth="6" fill="none" />
          <circle
            cx="34" cy="34" r={r}
            stroke="currentColor"
            strokeWidth="6"
            fill="none"
            strokeDasharray={c}
            strokeDashoffset={off}
            className="text-primary transition-all"
          />
        </svg>
        <div className="mt-1 text-center">
          <div className="text-sm font-medium tabular-nums">{pct}%</div>
          <div className="text-[10px] text-muted-foreground -mt-0.5">{label}</div>
          {sub && <div className="text-[9px] text-muted-foreground/70 tabular-nums">{sub}</div>}
        </div>
      </div>
    )
  }

  const headerNote = latestVoiceNote || (isToday ? 'Speak to log progress.' : 'No activity recorded for this day.')

  return (
    <div className="min-h-dvh bg-background px-4 pb-24 pt-6">
      <div className="mx-auto w-full max-w-[780px]">
        {/* Top nav + date */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[2px] text-muted-foreground">Daily Dashboard</div>
            <div className="text-3xl font-semibold tracking-tighter">How am I doing?</div>
          </div>

          {/* Compact date nav */}
          <div className="flex items-center gap-1.5 text-sm">
            <Button variant="outline" size="sm" onClick={() => changeDate(-1)} aria-label="Previous day">◀</Button>
            <Button
              variant={isToday ? 'default' : 'outline'}
              size="sm"
              onClick={goToday}
              className="min-w-[92px] tabular-nums"
            >
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => changeDate(1)} aria-label="Next day">▶</Button>

            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                const v = e.target.value as ISODate
                if (v) changeDate(v)
              }}
              className="ml-1 h-8 rounded border bg-background px-2 text-xs tabular-nums"
            />
            {!isToday && (
              <span className="ml-2 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Read-only</span>
            )}
          </div>
        </div>

        {/* Primary Headline: rings + synthesis */}
        <div className="mb-6 rounded-2xl border bg-card p-5">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-6">
              <ProgressRing value={focusProgress} label="Focus" sub={`${doneTasks.length}/${tasks.length} tasks`} />
              <ProgressRing value={proteinPct} label="Protein" sub={`${proteinCurrent}g / ${proteinTarget}g`} />
            </div>

            <div className="max-w-[420px] text-center sm:text-left">
              <div className="text-[13px] font-medium text-muted-foreground">Today at a glance</div>
              <div className="mt-1 text-xl leading-tight">
                {focusMinutes > 0 ? `${focusMinutes} min focus • ` : ''}
                {proteinCurrent > 0 ? `${proteinPct}% protein` : 'Log nutrition or tasks'}
              </div>
              <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                {headerNote}
              </div>
            </div>

            {/* Prominent mic trigger (only for today) */}
            {isToday && (
              <button
                onClick={handleFabClick}
                disabled={isVoiceProcessing}
                className={`flex size-16 items-center justify-center rounded-full border text-xl transition-all active:scale-[0.985] ${isListening ? 'border-red-500 bg-red-500 text-white shadow' : 'border-border hover:border-primary hover:text-primary'}`}
                aria-label={isListening ? 'Stop listening' : 'Start voice input'}
              >
                {isListening ? '■' : '🎤'}
              </button>
            )}
          </div>

          {(voiceStatus || isVoiceProcessing) && (
            <div className="mt-3 text-center text-[10px] uppercase tracking-[1px] text-muted-foreground/70">{voiceStatus}</div>
          )}
        </div>

        {/* Listening overlay (dims + waveform) */}
        {isListeningOverlay && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="rounded-2xl bg-background px-8 py-7 text-center shadow-xl">
              <div className="text-sm font-medium tracking-wide text-muted-foreground">Listening…</div>
              <div className="mt-3 flex items-end justify-center gap-1.5 h-10">
                {[0,1,2,3].map((i) => (
                  <div key={i} className="w-1.5 animate-pulse rounded bg-primary" style={{ height: 12 + (i % 3) * 7, animationDelay: `${i * 110}ms` }} />
                ))}
              </div>
              {interim && <div className="mt-3 text-sm text-muted-foreground">“{interim}”</div>}
              <button onClick={stopOverlayListening} className="mt-5 text-xs underline">Cancel</button>
              {listenError && <div className="mt-2 text-xs text-destructive">{listenError}</div>}
            </div>
          </div>
        )}

        {/* Confirmation banner (destructive / high impact) */}
        {pendingConfirm && (
          <div className="mb-4 rounded border border-border bg-accent/40 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-3">
            <div>
              Confirm: <span className="font-medium">{pendingConfirm.intentText}</span>
              <span className="text-muted-foreground"> — say “yes” or use buttons</span>
            </div>
            <div className="flex items-center gap-2">
              <VoiceInput
                confirmMode
                confirmPrompt={`Say yes to ${pendingConfirm.intentText || 'this action'} or no.`}
                onConfirm={confirmVoiceAction}
              />
              <Button variant="ghost" size="sm" onClick={() => confirmVoiceAction(false)}>Cancel</Button>
              <Button size="sm" onClick={() => confirmVoiceAction(true)}>Yes</Button>
            </div>
          </div>
        )}

        {/* FOCUS & TASKS */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Focus &amp; Tasks {isLoading && <span className="ml-2 text-xs text-muted-foreground">(loading…)</span>}</CardTitle>
          </CardHeader>
          <CardContent>
            {!isToday && (
              <div className="mb-3 rounded bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">Viewing past day — editing disabled.</div>
            )}

            {/* Quick add (today only) */}
            {isToday && (
              <form onSubmit={handleQuickAdd} className="mb-4 flex items-center gap-2">
                <Input
                  value={taskInput}
                  onChange={(e) => setTaskInput(e.target.value)}
                  placeholder="Add a task for today…"
                  className="flex-1"
                />
                <Button type="submit" size="sm" disabled={!taskInput.trim()}>Add</Button>
                <VoiceInput onTranscript={handleVoiceTranscript} />
              </form>
            )}

            {/* Open tasks (top) */}
            <div className="space-y-1">
              {openTasks.length === 0 && (
                <div className="py-3 text-sm text-muted-foreground">No open tasks. {isToday ? 'Add one above or speak.' : ''}</div>
              )}
              {openTasks.slice(0, 6).map((t) => (
                <div key={t.id} className="group flex items-start gap-3 rounded-md px-1 py-1.5 hover:bg-accent/40">
                  <button
                    onClick={() => toggleTaskDone(t.id)}
                    disabled={!isToday}
                    className="mt-1 size-5 shrink-0 rounded-full border border-border hover:border-primary disabled:opacity-50"
                    aria-label="Mark done"
                  />
                  <div className="min-w-0 flex-1 text-[0.97rem] leading-snug">{t.text}</div>
                  {t.estimatedMinutes && <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{t.estimatedMinutes}m</div>}
                </div>
              ))}
            </div>

            {doneTasks.length > 0 && (
              <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                {doneTasks.length} done today
              </div>
            )}
          </CardContent>
        </Card>

        {/* NUTRITION */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Nutrition</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-2 flex items-center justify-between text-sm">
              <div>Protein</div>
              <div className="tabular-nums text-muted-foreground">{proteinCurrent}g / {proteinTarget}g</div>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${proteinPct}%` }} />
            </div>

            <div className="mt-3 text-xs text-muted-foreground">
              Water: {(nutrition?.waterMl ?? 0)} ml
            </div>

            {(nutrition?.mealLogs?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Recent logs</div>
                <ul className="space-y-0.5 text-sm">
                  {nutrition!.mealLogs.slice(-3).reverse().map((m, idx) => (
                    <li key={idx} className="text-muted-foreground">
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {m.foodItems?.[0]?.name || 'meal'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isToday && <div className="mt-2 text-[10px] text-muted-foreground/70">Say “log 40g protein chicken” or “add water 300 ml”.</div>}
          </CardContent>
        </Card>

        {/* PLAN & SUGGESTIONS */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Plan &amp; AI Suggestions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {dailyPlan?.aiSuggestions?.length ? (
              <ul className="list-disc pl-5">
                {dailyPlan.aiSuggestions.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : (
              <div className="text-muted-foreground">No suggestions yet. Voice commands will populate plans over time.</div>
            )}
            {dailyPlan?.notes && <div className="text-muted-foreground">{dailyPlan.notes}</div>}
          </CardContent>
        </Card>

        {/* RECENT ACTIVITY (voice/AI, no extra cost) */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const rec = dashboard?.recent || { interactions: [], transcripts: [] }
              const combined = [
                ...(rec.interactions || []).map((i) => ({ ts: i.timestamp, label: 'AI', text: (i.response || i.intent || '').toString().slice(0, 120) })),
                ...(rec.transcripts || []).map((v) => ({ ts: v.timestamp, label: 'Voice', text: v.transcriptText?.slice(0, 120) || '' })),
              ].sort((a, b) => b.ts - a.ts).slice(0, 8)

              if (combined.length === 0) return <div className="text-sm text-muted-foreground">No voice or AI activity for this day.</div>

              return (
                <div className="space-y-2 text-sm">
                  {combined.map((c, idx) => (
                    <div key={idx} className="flex gap-2 text-muted-foreground">
                      <span className="mt-px inline-block w-[42px] shrink-0 font-mono text-[10px] text-muted-foreground/70">{new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="shrink-0 font-medium text-foreground/80">{c.label}:</span>
                      <span className="min-w-0 flex-1">{c.text}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </CardContent>
        </Card>

        {/* FINANCE (collapsed by default feel) */}
        <details className="mb-8">
          <summary className="cursor-pointer select-none text-sm text-muted-foreground">Finance snapshot (optional)</summary>
          <Card className="mt-2">
            <CardContent className="pt-4 text-sm text-muted-foreground">
              {dashboard ? 'Daily finance aggregates will appear here once tracked.' : '—'}
            </CardContent>
          </Card>
        </details>

        <div className="text-[10px] text-muted-foreground/60 flex items-center gap-2">
          {selectedDate} • TanStack Start + R2 {syncing && '• syncing…'} {isLoading && '• loading…'}
        </div>
      </div>

      {/* Always-present small voice input for confirm flows (ADR-004/005) */}
      {/* We keep one mounted so confirm dialogs work even if main FAB is used */}
      <div className="hidden">
        <VoiceInput onTranscript={() => {}} />
      </div>
    </div>
  )
}
