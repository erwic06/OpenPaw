# OpenPaw -- Implementation Plan

**Project:** OpenPaw
**Current Phase:** Phase 3 -- Headless Coding
**Last Updated:** 2026-03-26

---

### 2.1 -- NanoClaw Docker Container Setup
- **Status:** complete
- **Type:** infrastructure
- **Contract:** contracts/2.1-nanoclaw-docker.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `src/index.ts`, `src/secrets.ts`, `package.json`, `tsconfig.json`, `bun.lock`
- **Acceptance:** NanoClaw container builds and runs, mounts git repo and secrets volume

#### Notes
- Bun base image UID 1000 was taken; used UID 10001 for nanoclaw user
- Bun image pinned by manifest list digest (sha256:0733e50...) for multi-arch support
- Zero runtime dependencies; @types/bun 1.3.11 and typescript 6.0.2 as dev deps only
#### Failure History

---

### 2.2 -- Telegram Messaging Integration
- **Status:** complete
- **Type:** code
- **Contract:** contracts/2.2-telegram-integration.md
- **Dependencies:** 2.1
- **Assigned:** interactive
- **Artifacts:** `src/messaging/telegram.ts`, `src/messaging/index.ts`
- **Acceptance:** Bot connects, receives commands, sends messages

#### Notes
- grammy 1.41.1 (long-polling mode); HTML parse mode for alert formatting
- telegram_chat_id added as Docker Compose secret
- tsconfig: added allowImportingTsExtensions for Bun .ts import convention
#### Failure History

---

### 2.3 -- Plan Reader
- **Status:** complete
- **Type:** code
- **Contract:** contracts/2.3-plan-reader.md
- **Dependencies:** 2.1
- **Assigned:** interactive
- **Artifacts:** `src/plan/types.ts`, `src/plan/parser.ts`, `src/plan/reader.ts`
- **Acceptance:** Parses implementation_plan.md, detects ready tasks, watches for changes

#### Notes
- Zero dependencies added; uses Bun built-in fs.watch with polling fallback
- Debounces rapid file changes (500ms) for editor compatibility
#### Failure History

---

### 2.4 -- SQLite Database Setup
- **Status:** complete
- **Type:** infrastructure
- **Contract:** contracts/2.4-sqlite-setup.md
- **Dependencies:** 2.1
- **Assigned:** interactive
- **Artifacts:** `src/db/schema.sql`, `src/db/types.ts`, `src/db/index.ts`
- **Acceptance:** Database initializes with schema from design doc Sections 1 and 3 (4 tables), CRUD operations work

#### Notes
- Uses bun:sqlite (zero dependencies); WAL mode enabled
- Schema exactly matches design doc Sections 1 and 3
#### Failure History

---

### 2.5 -- HITL Gate Infrastructure
- **Status:** complete
- **Type:** code
- **Contract:** contracts/2.5-hitl-gates.md
- **Dependencies:** 2.2, 2.4
- **Assigned:** interactive
- **Artifacts:** `src/gates/index.ts`, `src/gates/types.ts`, `src/gates/formatter.ts`
- **Acceptance:** All 6 gate types supported; gates can be created, sent via Telegram, resolved via reply; decisions logged to SQLite

#### Notes
- Dependency injection (GateDeps) for testability; no new npm packages
- Pending gate registered before async send to avoid race between response and registration
- Text-based response matching: single pending gate auto-targets; multiple gates require gate ID
- Feedback accumulates in-memory per gate, returned in GateResult on resolution
- 18 tests covering all acceptance criteria
#### Failure History

---

### 2.6 -- launchd LaunchAgent for Auto-Start
- **Status:** complete
- **Type:** infrastructure
- **Contract:** contracts/2.6-launchd-agent.md
- **Dependencies:** 2.1
- **Assigned:** interactive
- **Artifacts:** `com.openpaw.nanoclaw.plist`, `scripts/nanoclaw-start.sh`, `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh`
- **Acceptance:** NanoClaw starts on boot, restarts on crash, logs to file

#### Notes
- Plist is a template with `__REPO_DIR__` and `__HOME_DIR__` placeholders; install script resolves them via sed
- Wrapper script (`nanoclaw-start.sh`) waits up to 5 min for Docker Desktop, then exec's docker compose up
- KeepAlive=true + ThrottleInterval=10s ensures restart within 10 seconds of process exit
- Docker's `restart: unless-stopped` handles container-level crashes; launchd handles process/system-level restarts
- macOS TCC: repos under ~/Documents require Full Disk Access for /bin/bash; production Mac Mini should use a non-protected path or grant FDA
- No new dependencies added
#### Failure History

---

### 3.1 -- AgentAdapter Interface and Types
- **Status:** ready
- **Type:** code
- **Contract:** contracts/3.1-agent-adapter-types.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/agents/types.ts`, `src/agents/index.ts`
- **Acceptance:** AgentAdapter interface with 4 methods, ModelRoster with 3 tiers, all types exported, typecheck passes

#### Notes
#### Failure History

---

### 3.2 -- Coder Agent System Prompt
- **Status:** ready
- **Type:** content
- **Contract:** contracts/3.2-coder-system-prompt.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `agents/coder/system_prompt.md`
- **Acceptance:** System prompt exists with lifecycle, tools, constraints, and output format

#### Notes
#### Failure History

---

### 3.3 -- Cost Tracking Module
- **Status:** ready
- **Type:** code
- **Contract:** contracts/3.3-cost-tracking.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/costs/pricing.ts`, `src/costs/index.ts`
- **Acceptance:** Cost calculation, logging, and aggregation for all 6 models; tests pass

#### Notes
#### Failure History

---

### 3.4 -- Daytona Sandbox Manager
- **Status:** ready
- **Type:** code
- **Contract:** contracts/3.4-daytona-sandbox.md
- **Dependencies:** 3.1
- **Assigned:** interactive
- **Artifacts:** `src/sandbox/types.ts`, `src/sandbox/index.ts`
- **Acceptance:** Sandbox create/get/destroy lifecycle, package audit, tests pass

#### Notes
#### Failure History

---

### 3.5 -- Agent SDK Integration + LLMAdapter
- **Status:** ready
- **Type:** code
- **Contract:** contracts/3.5-agent-sdk-llm-adapter.md
- **Dependencies:** 3.1, 3.3
- **Assigned:** interactive
- **Artifacts:** `src/agents/llm-adapter.ts`
- **Acceptance:** LLMAdapter implements AgentAdapter, spawns Claude Code sessions, tracks usage; Docker build succeeds

#### Notes
#### Failure History

---

### 3.6 -- Daytona MCP Tools for Coder
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.6-daytona-mcp-tools.md
- **Dependencies:** 3.4, 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/tools/daytona-tools.ts`, `src/agents/tools/index.ts`
- **Acceptance:** File, shell, and git tools proxy through Daytona sandbox; path scoping enforced; tests pass

#### Notes
#### Failure History

---

### 3.7 -- Fallback Routing
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.7-fallback-routing.md
- **Dependencies:** 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/fallback.ts`, `src/agents/openai-adapter.ts`
- **Acceptance:** Retry with backoff, fallback to OpenAI per roster, Telegram alert on fallback; tests pass

#### Notes
#### Failure History

---

### 3.8 -- Session Monitoring
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.8-session-monitoring.md
- **Dependencies:** 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/monitor.ts`
- **Acceptance:** Detects hung sessions (10min), kills and marks FAILED, sends alert; tests pass

#### Notes
#### Failure History

---

### 3.9 -- Session Runner + Orchestrator Wiring
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.9-session-runner.md
- **Dependencies:** 3.2, 3.6, 3.7, 3.8
- **Assigned:** interactive
- **Artifacts:** `src/agents/runner.ts`, `src/plan/writer.ts`
- **Acceptance:** Full task lifecycle orchestration, plan writer, index.ts wiring; tests pass

#### Notes
#### Failure History

---

### 3.10 -- Cubic Integration
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.10-cubic-integration.md
- **Dependencies:** 3.6
- **Assigned:** interactive
- **Artifacts:** `src/integrations/cubic.ts`
- **Acceptance:** Polls GitHub for Cubic review, captures summary; tests pass

#### Notes
#### Failure History

---

### 3.11 -- Deploy Gate Wiring
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.11-deploy-gate.md
- **Dependencies:** 3.9
- **Assigned:** interactive
- **Artifacts:** (modifies existing files)
- **Acceptance:** Deploy-tagged tasks trigger Gate 2 with context; tests pass

#### Notes
#### Failure History

---

### 3.12 -- Restart Recovery
- **Status:** blocked
- **Type:** code
- **Contract:** contracts/3.12-restart-recovery.md
- **Dependencies:** 3.9
- **Assigned:** interactive
- **Artifacts:** `src/agents/recovery.ts`
- **Acceptance:** Detects orphaned sessions on startup, marks FAILED, resets tasks, alerts; tests pass

#### Notes
#### Failure History

---

## Session Log

| Session | Date | Task | Status | Duration | Notes |
|---------|------|------|--------|----------|-------|
| 1       | 2026-03-25 | 2.1  | complete | —      | Docker infra created: multi-stage Dockerfile, docker-compose.yml with secrets/volumes/security hardening, health check endpoint, secrets loader. All acceptance criteria verified. |
| 2       | 2026-03-25 | 2.2  | complete | —      | Telegram bot module: grammy 1.41.1, sendMessage/onMessage/formatAlert, auth filtering, HTML alert formatting. Docker build verified. |
| 3       | 2026-03-25 | 2.3  | complete | —      | Plan reader: parsePlan, getReadyTasks, watchPlan with fs.watch + polling fallback. 12 tests passing. No new dependencies. |
| 4       | 2026-03-26 | 2.4  | complete | —      | SQLite setup: bun:sqlite, 4 tables (sessions, hitl_gates, cost_log, pending_communications), WAL mode, typed CRUD. 8 tests passing. |
| 5       | 2026-03-26 | 2.5  | complete | —      | HITL gate infrastructure: 6 gate types, requestApproval/getPendingGates, Telegram response matching, feedback accumulation, timeout support. DI for testability. 18 tests passing, 38 total. |
| 6       | 2026-03-26 | 2.6  | complete | —      | launchd LaunchAgent: plist template with path substitution, wrapper script with Docker wait loop, install/uninstall scripts. KeepAlive + ThrottleInterval(10s). All 38 tests passing. |
| 7       | 2026-03-26 | —    | complete | —      | Phase 3 scaffolding: wrote 12 contracts (3.1-3.12), added Phase 3 task entries to implementation plan, updated current phase to Phase 3. |
