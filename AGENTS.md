# AGENTS.md - Personal Life Improvement Assistant

## Project Mission
Build a personal AI assistant that improves the user's life through:
- Physical fitness (workouts, planning, tracking)
- Nutrition (meal tracking, food logging, suggestions)
- Family care
- Financial growth (stock suggestions, finance advice)
- Productivity (existing kanban, todos)
- Voice-first interaction

**Current user**: Brian Kimball (primary person to improve)

## Core Principles
1. **Person-first**: Every feature must demonstrably improve the user's life
2. **AI-friendly docs**: All documentation must be structured for agent consumption
3. **Voice-native**: Primary interaction via voice
4. **Privacy-first**: User data stays local or encrypted
5. **Actionable suggestions**: AI doesn't just track—it recommends and plans

## Tech Stack
- TanStack Start (React + SSR) deployed on Cloudflare Workers + Pages
- Cloudflare R2 as primary persistent data store (user-scoped objects)
- TanStack DB for reactive client-side state only
- TanStack AI + TanStack AI React for AI features
- Grok API (xAI) as primary LLM (server-side via Workers)
- shadcn/ui + Tailwind for UI
- Vite for build

See `.agents/adrs/001-cloudflare-r2-deployment.md` for deployment architecture.

## Current State
- Basic TanStack Start app with routing
- Kanban board (productivity)
- Todo app (productivity)
- Theme toggle, basic UI components

## Priority Features (in order)
1. Voice input/output system
2. Workout tracking + AI-suggested plans
3. Meal/food logging + nutrition suggestions
4. Finance tracker + stock/finance AI advisor
5. Family task/care coordination
6. Unified daily/weekly improvement dashboard

## Documentation Standards for Agents
- All ADRs go in `.agents/adrs/`
- Domain models and agent context go in `.agents/ai/`
- Human-facing docs go in `docs/`
- Handoff documents go in `.agents/handoffs/`
- Every feature must have an ADR before implementation
- Code must be self-documenting with clear types
- Agent-readable comments only when logic is non-obvious

## AI Integration Rules
- All AI calls go through TanStack AI abstractions
- Grok API keys stored securely (never committed)
- Responses must be actionable (plans, suggestions, not just data)
- Voice transcription → structured intent → action

## Contribution Rules for Agents
- Never add features that don't directly improve the user's life
- Always update AGENTS.md when architecture changes
- Create ADR for every new major domain
- Prefer TanStack ecosystem solutions
