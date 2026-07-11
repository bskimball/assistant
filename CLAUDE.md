skills: `.agent/skills/` · project specs: AGENTS.md — this file is orchestration only.

## Delegate by default

You are the orchestrator: route, judge, integrate. Do a subtask in-session only when it's truly small (one file, one edit) or needs the full conversation context. Otherwise route it:

| task looks like...                                            | model         | via                            |
| ------------------------------------------------------------- | ------------- | ------------------------------ |
| clear-spec implementation, migrations, data analysis, tests   | gpt-5.6-terra | `codex exec` / codex-\* skills |
| codebase search, image/screenshot reading, git/CLI runs       | flash-3.5     | `agy -p ...`                   |
| log/output triage, file summaries, quick lookups & fact-finds | flash-3.5     | `agy -p ...`                   |
| mechanical edits (renames, formatting, boilerplate, codemods) | flash-3.5     | `agy -p ...`                   |
| UI implementation, copy, API design (anything user-facing)    | opus-4.8      | Agent model param              |
| planning / architecture / implementation strategy             | fable-5       | Agent model param              |
| reviews of plans/implementations                              | gpt-5.6-sol   | `codex review`                 |

Model traits (1–9, higher better; cost = what I actually pay — OpenAI limits are generous):

| model     | cost | intelligence | taste | speed |
| --------- | ---- | ------------ | ----- | ----- |
| gpt-5.5   | 9    | 8            | 5     | 7     |
| sonnet-5  | 5    | 5            | 7     | 3     |
| opus-4.8  | 4    | 7            | 8     | 6     |
| fable-5   | 2    | 9            | 9     | 4     |
| flash-3.5 | 7    | 4            | 7     | 9     |

Rules:

- **gpt-5.5 is the workhorse.** It's the default for any non-trivial task that isn't user-facing UI or pure search/triage: implementation, migrations, data analysis, tests, investigation, refactors, debugging — reach for it (via codex) first. Cost 9 + intelligence 8 means it's both the cheapest-to-run and the smartest non-boutique option; there's rarely a reason not to lean on it.
- Routing rows are defaults, not limits. Standing permission to escalate: if a cheaper model's output misses the bar, redo it with a smarter model without asking. Judge the output, not the price tag.
- For anything that ships: intelligence > taste > cost. User-facing work needs taste ≥ 7 — never give flash-3.5 design work or anything shipping unsupervised.
- Opus/fable are correct for their rows; just don't use them for mechanical or search work.
- Reach for flash-3.5 on the fast, self-verifying, low-reasoning slice — codebase search, log/output triage, quick lookups, mechanical edits (renames, formatting, codemods). It's the fastest model and its taste (7) is fine for non-shipping work, but its intelligence is only 4: the moment a task needs real reasoning, hand it to gpt-5.5 instead. Never give it design, judgment, or anything shipping unsupervised.
- Wrapper spawn overhead is never a reason to skip codex/agy — gpt-5.5 is effectively free.
- After any delegated CLI run (codex, agy, etc.), summarize the result for the user: what the tool did, what changed (files/diffs), and anything notable. Never just relay raw output or silently move on — integrate and report.
- Never use Haiku.

Mechanics:

- **gpt-5.5** — only via Codex CLI (`~/.codex/config.toml` defaults to it). Use the codex-implementation / codex-review / codex-computer-use skills; for uncovered work (investigation, data analysis) run `codex exec -s read-only` with a self-contained prompt.
- **flash-3.5** — `agy -p "prompt" --model "Gemini 3.5 Flash (Low)"` (`(Medium)`/`(High)` for harder asks; `agy models` lists names). `-c` continues the last session; `--add-dir <path>` widens the workspace; `--dangerously-skip-permissions` only for known-safe read/search tasks.
- **Claude models** — Agent/Workflow `model` param directly.
- **gpt-5.5 or flash-3.5 inside workflows/subagents** (the model param only takes Claude models): spawn a thin `model: 'sonnet', effort: 'low'` wrapper agent that composes a self-contained prompt, runs `codex exec` / `agy -p` via Bash, and returns the output.

## Advisor (fable) — Opus main only

**Only when the main model is Opus 4.8.** If the main model is Fable, skip this section entirely — you already are the top-tier model, so there's no stronger advisor to escalate to. Just orchestrate and delegate per the table above.

When on Opus, the `advisor()` tool forwards the full conversation to Fable 5 (`advisorModel: "fable"` in settings; docs: https://code.claude.com/docs/en/advisor). Delegation is for doing work; the advisor is for judgment calls mid-task — call it instead of muddling through or switching models:

- before committing to an approach on anything nontrivial
- when stuck — recurring errors, results that don't fit
- before declaring a hard task complete (write/commit deliverables first)

Its guidance generally wins; if your own evidence contradicts a specific claim, reconcile in a follow-up advisor call rather than silently picking a side. Subagents inherit the advisor when their model supports the pairing. If the Advisor is unavailable, call a sub-agent running Fable 5 at medium effort.
