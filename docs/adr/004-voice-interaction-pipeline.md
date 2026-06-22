# ADR-004: Voice Interaction Pipeline (STT → Intent → Action)

**Status**: Accepted  
**Date**: 2026-06-22  
**Deciders**: Brian Kimball

## Context

AGENTS.md establishes “Voice-native” and “Voice-first interaction” as core principles. The user’s primary interaction with the assistant should be spoken, not typed. ADR-002 introduced `VoiceTranscript` and `AIInteraction` as first-class append-only entities. ADR-003 locked the R2 layout for these entities under `assistant/brian/ai/transcripts/` and `assistant/brian/ai/interactions/`.

We now need an end-to-end voice pipeline that:

- Captures audio in the browser with zero server cost for v1.
- Produces a durable `VoiceTranscript`.
- Converts spoken intent into structured, executable actions.
- Executes safely (immediate for additive actions, confirmation for destructive).
- Integrates cleanly with the new daily aggregate model (`ProductivityTask`, `DailyNutrition`, etc.).
- Remains fully compatible with the existing single-user (`brian`) tenancy model.

## Decision

Adopt a staged voice pipeline with the following contract.

### 1. Capture & STT (v1 – Browser Native)

- Use the browser’s built-in `SpeechRecognition` (Web Speech API).
- On successful recognition, immediately persist a `VoiceTranscript` record (text, duration, language, timestamp, userId).
- Audio blob storage is deferred; only the transcript text is stored in v1.
- Later migration path: MediaRecorder → R2 audio object → server-side STT (Grok/Whisper) behind the same interface.

### 2. Intent Extraction

- `rawTranscript` + minimal context (current date, last few `AIInteraction`s) is sent to Grok via TanStack AI.
- The model is prompted to return a single structured `intent` JSON object:
  ```json
  {
    "action": "logMeal" | "createTask" | "startWorkout" | ...,
    "payload": { ... },
    "confidence": 0.92,
    "requiresConfirmation": false
  }
  ```
- Unknown or low-confidence intents fall back to a clarification question spoken by the assistant.

### 3. Safety & Execution Model

- **Immediate execution** (no confirmation) for additive / read-only actions:
  - `logMeal`, `logWater`, `createTask`, `startFocusTimer`, `logWorkoutSession`, etc.
  - Assistant speaks a short, non-intrusive confirmation (“Meal logged – 42 g protein”).
- **Explicit voice confirmation required** for destructive or high-impact actions:
  - `deleteTask`, `archivePlan`, `markTaskComplete` (if irreversible), financial transfers, etc.
  - Assistant asks: “Delete the ‘buy groceries’ task – are you sure?”
  - Only on affirmative reply is the action executed.
- Every execution path (success, cancelled, or error) produces a full `AIInteraction` record for audit and later undo.

### 4. Storage (per ADR-003)

- `VoiceTranscript` → `assistant/brian/ai/transcripts/{transcriptId}.json`
- `AIInteraction` → `assistant/brian/ai/interactions/{ISO-timestamp}-{shortIntent}.json`
- Both remain pure append-only logs (never compacted).

### 5. Integration with Productivity & Daily Aggregates

- Voice intents that target tasks resolve the target date (`today`, `tomorrow`, explicit date) from the payload or conversation context.
- New `ProductivityTask` records are written directly into the new structure:
  - `daily/{targetDate}/productivity.json` (snapshot)
  - `daily/{targetDate}/productivity-events.json` (append)
- During the migration window, a compatibility shim also writes to the legacy `todos.json` so existing UI components continue to function.
- Once the UI is updated to read the daily aggregate, the legacy write path is removed.

### 6. Error Handling & Resilience

- STT failure → graceful fallback to text input with the partial transcript pre-filled.
- Intent execution failure (validation error, R2 write failure) → spoken error + `AIInteraction` marked `failed` so the user can retry or correct.
- Network loss mid-pipeline → local queue (IndexedDB) with retry on reconnect; user sees optimistic UI feedback.

## Consequences

**Positive**

- Zero-cost v1 voice experience using only browser APIs.
- Clear safety model protects against accidental voice-triggered destructive actions.
- Full audit trail via `VoiceTranscript` + `AIInteraction` satisfies privacy and personalization needs.
- Direct integration with the new daily aggregate model keeps the domain model consistent.
- Staged architecture allows future accuracy/offline improvements without changing the intent contract.

**Negative**

- Browser `SpeechRecognition` quality varies by device/OS; may require later server-side STT for some users.
- Two write paths (new daily aggregate + legacy) during migration increase complexity.
- Confirmation step adds a small amount of friction for high-impact actions.

**Risks & Mitigations**

- Accidental execution of destructive actions via voice → strict confirmation list + full `AIInteraction` history for undo.
- STT producing garbage transcripts on noisy days → confidence threshold + clarification fallback.
- Legacy `todos.json` drift during migration → nightly reconciliation worker or removal of legacy path once UI is migrated.

## Alternatives Considered

1. **Server-side STT from day one** (MediaRecorder + Grok/Whisper) – Higher accuracy and offline support, but adds cost, latency, and infrastructure. Rejected for v1.
2. **Always require confirmation** – Safer but destroys the fluid “voice-first” experience for the 90 % of additive actions. Rejected.
3. **Daily JSONL for transcripts** (`voice-transcripts/YYYY-MM-DD.jsonl`) – More efficient appends at scale, but each transcript loses its own object identity (harder to attach audio later, harder to soft-delete individually). Kept as future optimization; current per-object layout accepted.

## Next Steps

1. Implement client-side `VoiceInput` component using Web Speech API.
2. Create `VoicePipelineService` (or TanStack AI route) that orchestrates STT → intent → execution.
3. Add `VoiceTranscript` and `AIInteraction` persistence helpers under the existing `src/server/adapters/r2.ts` pattern.
4. Define the canonical intent schema and prompt templates for Grok.
5. Build the confirmation dialog + TTS playback for assistant responses.
6. Update AGENTS.md priority list (voice is now the top implementation target).
7. ADR-005: Unified Daily Improvement Dashboard (reads all daily aggregates + recent voice/AI activity).
