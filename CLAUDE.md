skills are in .agent/skills/

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay (OpenAI has really generous limits), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model     | cost | intelligence | taste | speed |
| --------- | ---- | ------------ | ----- | ----- |
| gpt-5.5   | 9    | 8            | 5     | 7     |
| sonnet-5  | 5    | 5            | 7     | 3     |
| opus-4.8  | 4    | 7            | 8     | 6     |
| fable-5   | 2    | 9            | 9     | 4     |
| flash-3.5 | 7    | 4            | 7     | 9     |

**Default to delegating.** You are the orchestrator: your job is routing, judgment, and integration — not doing the work in-session. Before starting any subtask yourself, route it through the table below. Doing it yourself is the exception, reserved for tasks that are truly small (one file, one edit) or that require the full conversation context.

Routing table — match the task, use that model, no deliberation needed:

| task looks like...                                                               | route to            | via                            |
| -------------------------------------------------------------------------------- | ------------------- | ------------------------------ |
| clear-spec implementation, migrations, data analysis, test writing               | gpt-5.5             | `codex exec` / codex-\* skills |
| codebase search, reading/describing images or screenshots, git/wrangler/CLI runs | flash-3.5           | `agy -p ...`                   |
| UI implementation, copy, API design (anything user-facing)                       | opus-4.8 or fable-5 | Agent model param              |
| planning / architecture / implementation strategy                                | fable-5 or Opus-4.8 | Agent model param              |
| reviews of plans/implementations                                                 | gpt-5.5             | `codex review`                 |

Rules:

- Opus/fable are the right pick for their rows (user-facing work, planning) — use them freely there. Just don't reach for them for mechanical or search work; that's what gpt-5.5 and flash-3.5 are for.
- The wrapper overhead for codex/agy is not a reason to skip them — a thin wrapper agent takes seconds to spawn and gpt-5.5 is effectively free.
- These are defaults, not limits. Standing permission to escalate: if a cheaper model's output doesn't meet the bar, redo it with a smarter model without asking. Judge the output, not the price tag.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Anything user-facing needs taste ≥ 7. Don't hand flash-3.5 design work or anything that ships unsupervised — low intelligence; escalate if its output misses.
- Never use Haiku.
- Mechanics: gpt-5.5 is only reachable through the Codex CLI — `codex exec` / `codex review` (my ~/.codex/config.toml defaults to gpt-5.5). Use the codex-implementation, codex-review, and codex-computer-use skills; for work they don't cover (investigation, data analysis), run `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents (the model parameter only takes Claude models, so use a wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it to write a self-contained codex prompt, run `codex exec` via Bash, and return the output.

Using flash-3.5 via the Antigravity CLI (`agy`):

- One-shot, non-interactive (the usual way): `agy -p "your prompt" --model "Gemini 3.5 Flash (Low)"` — use `(Medium)` or `(High)` for harder asks. `agy models` lists exact model names.
- Follow-up in the same conversation: add `-c` to continue the most recent session.
- It runs in the current directory; use `--add-dir <path>` to widen the workspace, `--sandbox` for restricted terminal access, and `--dangerously-skip-permissions` only for known-safe read/search tasks that would otherwise stall on prompts.
- Same wrapper pattern as gpt-5.5 applies inside workflows/subagents: a thin `model: 'sonnet', effort: 'low'` agent that composes the prompt, runs `agy -p ...` via Bash, and returns the output.

refer to AGENTS.md for project specs — this file is for orchestration
