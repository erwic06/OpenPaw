# OpenPaw -- Project Specification

## Overview

OpenPaw is a personal agent fleet management system. It orchestrates coding, research, and custom agents — both LLM-native and external standalone services — through a centralized daemon (NanoClaw) running on a Mac Mini, with a web dashboard and Telegram bot for human interaction.

## Goals

- Orchestrate multiple agent types (Coder, Researcher, Reviewer, custom scheduled agents, external service agents) through a uniform agent interface and structured task lifecycle
- Support two agent adapter types: LLM-native (API sessions against Anthropic/OpenAI/Google) and external services (standalone services with HTTP APIs)
- Enforce HITL (human-in-the-loop) approval gates for high-stakes actions: plan approval, production deploys, spec changes, research briefs, spend thresholds, external communication
- Provide a web dashboard (OpenPaw Web) for real-time session monitoring, task management, HITL gate resolution, and content review/approval for outbound communications
- Route tasks to appropriate LLM providers (Anthropic, OpenAI, Google) with automatic fallback on failure
- Accept task intake via Telegram bot (/research, /deep-research, /project, /coding) and web dashboard
- Support custom scheduled agents defined as markdown files with cron or event-based triggers
- Track costs per session and enforce daily budget limits
- Execute headless coding sessions in local workspaces (git clone) with automated code review (Claude Reviewer)

## Non-Goals

- Multi-user support -- single user (Eric), single Mac Mini
- Commercial deployment or SaaS features
- Mobile app -- Telegram and web dashboard are sufficient
- Real-time collaboration -- this is a personal system
- Custom cost dashboard (use SQLite queries and provider dashboards)
- Automated key rotation (manual at current scale)

## Constraints

- **Host:** Mac Mini (orchestration only, no heavy compute)
- **Runtime:** Node.js / Bun for NanoClaw
- **Persistence:** SQLite for operational metadata, Git repo for all artifacts
- **Auth:** Cloudflare Access (GitHub OAuth + MFA) for web dashboard; single authorized user
- **Code execution:** Local workspaces (git clone from mounted repo) inside the NanoClaw Docker container
- **Frontend:** Next.js on Vercel, 21st.dev components, dark theme with amber/gold accent
- **Supply chain security:** Exact version pins, committed lock files, `--ignore-scripts` in all installs, Docker Compose secrets (not env vars), non-root container user. See design doc Section 2.

## Success Criteria

Phase exit criteria from the design document:

- [ ] **Phase 1:** 5+ tasks completed through the manual lifecycle; plan accurately reflects project state without manual fixes
- [ ] **Phase 2:** NanoClaw correctly identifies ready tasks and sends notifications; HITL gates work via Telegram
- [ ] **Phase 3:** 10+ headless tasks completed; at least one fallback-to-GPT event handled; at least one deploy gate triggered
- [ ] **Phase 4:** 3+ research briefs completed end-to-end; Reviewer catches at least one issue
- [ ] **Phase 5:** All failure modes from design doc simulated and verified; budget hard-stop tested; restart recovery tested
- [ ] **Phase 6:** 5+ research tasks via Telegram; 1+ project created via Telegram; cost estimates within 2x of actual
- [ ] **Phase 7:** All Telegram functionality also available via webapp; real-time streaming works; auth blocks unauthorized access
- [ ] **Phase 8:** 1+ cron agent running reliably for 1 week; 1+ event-triggered agent fires correctly; output routing works

## Technical Context

- Full design document: `openpaw-design-document.md`
- Architecture: NanoClaw daemon (Docker) + Claude Code / Codex (headless agents) + local workspaces
- Two state stores: Git repo (source of truth) + SQLite (operational metadata)
- Agent types: Planner, Coder, Researcher, Reviewer, Custom (LLM-native or external service)
- Agent abstraction: uniform AgentAdapter interface with LLMAdapter and ServiceAdapter implementations
- LLM providers: Anthropic (Sonnet/Opus), OpenAI (GPT-5.4/Codex), Google (Gemini 3.1 Pro)
- Browser automation: BrowserUse CLI 2 (direct CDP) — general-purpose tool, dual-mode (CLI local + Cloud API)

## Revision History

| Date       | Change                          | Author |
|------------|---------------------------------|--------|
| 2026-03-06 | Initial specification created   | Eric   |
| 2026-03-24 | Add uniform agent interface (LLM + external service adapters), promote external communication gate to first-class feature, add content review dashboard tab | Eric |
| 2026-03-24 | BrowserUse CLI 2 as general-purpose dual-mode browser tool for all agents | Eric |
| 2026-03-31 | Replace Daytona/Cubic with local workspaces and Claude Reviewer (lean overhaul) | Eric |
