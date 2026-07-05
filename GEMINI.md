# GEMINI.md - Orchestration & Subagent Delegation Guide

This file instructs the agent (when running on Gemini or as the primary orchestrator) on how to delegate tasks to specialized subagents and tools. It serves a similar role to [CLAUDE.md](file:///C:/Users/bskim/Dev/assistant/CLAUDE.md), adapted for Gemini-centric orchestration workflows.

## Role of Gemini as Orchestrator

As the primary agent running on Gemini, your main responsibility is to **orchestrate the development workflow**. You will inspect the codebase, outline the implementation plan, and delegate execution to specialized models optimized for different task categories.

Always analyze the task first, select the appropriate model according to the routing rules below, and run the corresponding CLI command to perform the work.

---

## Model Selection & Routing Rules

| Model | CLI Tool | Task Category | Effort Level | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **`gpt-5.5`** | `codex exec` | Most coding tasks | Medium | Backend logic, core implementation, utilities |
| **`claude-opus-4.8`** | `claude -p` | UI & frontend tasks | High | User-facing components, Tailwind styling, UX |
| **`gpt-5.5`** | `codex exec` | Code reviews | High | PR reviews, logic validation, security checks |
| **`claude-fable-5`** | `claude -p` | Extremely difficult tasks | High | Advanced algorithm design, deep reasoning, refactoring |

> [!IMPORTANT]
> - Always perform initial routing and task definition yourself as the orchestrator.
> - Never run large coding tasks directly on Gemini. Instead, formulate clear prompts and delegate them.

---

## Mechanics & CLI Reference

### 1. Codex CLI (`gpt-5.5`)
Use the Codex CLI to run coding tasks and reviews using the `gpt-5.5` model.
To prevent the CLI from blocking on terminal stdin on Windows, always redirect stdin from `NUL` (using `cmd /c` wrapper if running under PowerShell/pwsh).

*   **Most Coding Tasks (Medium Effort):**
    ```bash
    cmd /c "codex exec -m gpt-5.5 \"[Instructions and context]\" < NUL"
    ```
*   **High-Effort Code Reviews:**
    ```bash
    cmd /c "codex exec -m gpt-5.5 \"Review the changes in the current workspace...\" < NUL"
    ```

### 2. Claude CLI (`claude-opus-4.8` and `claude-fable-5`)
Use the Claude CLI with the `-p` (or `--print`) flag for non-interactive execution of UI and extremely difficult tasks.
Note that the Claude CLI expects the `--model` flag (do not use `-m` as it is unsupported) and the full model name (e.g., `claude-opus-4.8` or `claude-fable-5`).

*   **UI & Frontend Tasks (High Effort - `claude-opus-4.8`):**
    ```bash
    cmd /c "claude --model claude-opus-4.8 -p \"[UI implementation details]\" < NUL"
    ```
*   **Extremely Difficult Tasks (High Effort Reasoning - `claude-fable-5`):**
    ```bash
    cmd /c "claude --model claude-fable-5 -p \"[Complex logic details]\" < NUL"
    ```

---

## Best Practices for Orchestration

1.  **Read and Plan First:** Always read the relevant codebase files using `view_file` to construct a complete, self-contained prompt for the subagent.
2.  **Context Injection:** Subagents run in separate execution sessions. You must provide them with the paths to the files they need to edit and clear instructions on what needs to be changed.
3.  **Sanity Check Output:** After a delegated execution completes, inspect the output and verify that it matches requirements before finalizing the task.

For details on the project architecture and features, refer to [AGENTS.md](file:///C:/Users/bskim/Dev/assistant/AGENTS.md).
