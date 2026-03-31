# OpenPaw -- Implementation Plan

**Project:** OpenPaw
**Current Phase:** Phase 3 -- Headless Coding
**Last Updated:** 2026-03-30

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
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.1-agent-adapter-types.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/agents/types.ts`, `src/agents/index.ts`
- **Acceptance:** AgentAdapter interface with 4 methods, ModelRoster with 3 tiers, all types exported, typecheck passes

#### Notes
- Pure types module: AgentAdapter interface (4 methods), AgentInput/AgentOutput, ModelTier/ModelConfig/ModelRoster, DEFAULT_ROSTER constant
- Zero runtime dependencies; all types match design doc Section 1
- Fixed pre-existing test fragility in parser.test.ts (hardcoded task IDs → invariant-based assertions)
#### Failure History

---

### 3.2 -- Coder Agent System Prompt
- **Status:** complete
- **Type:** content
- **Contract:** contracts/3.2-coder-system-prompt.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `agents/coder/system_prompt.md`
- **Acceptance:** System prompt exists with lifecycle, tools, constraints, and output format

#### Notes
- 5-phase headless lifecycle (Orient/Execute/Verify/Update/Terminate) — Select phase collapsed since NanoClaw pre-assigns tasks
- Filesystem access table mirrors design doc Section 1 matrix; hard stop conditions match CLAUDE.md
- Structured result report template for machine-parseable session output
#### Failure History

---

### 3.3 -- Cost Tracking Module
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.3-cost-tracking.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/costs/pricing.ts`, `src/costs/index.ts`
- **Acceptance:** Cost calculation, logging, and aggregation for all 6 models; tests pass

#### Notes
- Pricing from Anthropic and OpenAI pricing pages (2026-03-29); gpt-5.4-high and gpt-5.4-medium share same per-token rate (same model, different reasoning.effort)
- DI via CostTrackerDeps; zero runtime dependencies; 13 new tests
#### Failure History

---

### 3.4 -- Local Workspace Manager
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.4-local-workspace.md
- **Dependencies:** 3.1
- **Assigned:** interactive
- **Artifacts:** `src/sandbox/types.ts`, `src/sandbox/index.ts`
- **Acceptance:** Workspace create/get/destroy lifecycle via local dirs + git clone; tests pass

#### Notes
- Originally Daytona sandbox manager; rewritten in lean integration overhaul (session 17)
- Now uses local directories + git clone from /repo mount — zero external dependencies
- SandboxDeps simplified to { baseDir }; SandboxHandle simplified to { sessionId, workDir }
- 12 tests using real temp directories and local git repos
#### Failure History

---

### 3.5 -- Agent SDK Integration + LLMAdapter
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.5-agent-sdk-llm-adapter.md
- **Dependencies:** 3.1, 3.3
- **Assigned:** interactive
- **Artifacts:** `src/agents/llm-adapter.ts`
- **Acceptance:** LLMAdapter implements AgentAdapter, spawns Claude Code sessions, tracks usage; Docker build succeeds

#### Notes
- @anthropic-ai/claude-agent-sdk 0.2.87 (2 direct deps: @anthropic-ai/sdk, @modelcontextprotocol/sdk), @anthropic-ai/claude-code 2.1.87 (0 deps), zod 4.3.6 (0 deps); 0 audit vulnerabilities
- DI via LLMAdapterDeps: queryFn override for testing, cwd for workspace directory
- Background session execution: trigger() returns immediately, runSession() iterates query() async generator
- getLastActivityMs() exposed for session monitoring (Task 3.8)
- Result usage is treated as cumulative (overwrites, not adds)
- Dockerfile adds node_modules/.bin to PATH for Claude CLI access
- 20 new tests, 83 total passing
#### Failure History

---

### 3.6 -- Codex Adapter (replaced Daytona MCP Tools)
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.6-codex-adapter.md
- **Dependencies:** 3.4, 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/codex-adapter.ts`
- **Acceptance:** CodexAdapter implements AgentAdapter, spawns Codex sessions via @openai/codex-sdk, tracks usage; tests pass

#### Notes
- Originally Daytona MCP tools; replaced with CodexAdapter in lean integration overhaul (session 17)
- @openai/codex-sdk 0.117.0 (1 dep: @openai/codex CLI); Daytona SDK and openai package removed
- CodexAdapter mirrors LLMAdapter: startThread/runStreamed, event-based usage tracking, DI via codexFactory
- Codex uses native tools (file/shell/git) — no MCP tools needed
- Model mapping: light → gpt-5.4-mini, standard/heavy → gpt-5.4
- Tier-based routing: heavy/standard → Claude Code, light → Codex, with cross-provider fallback
- 20 new Codex adapter tests
#### Failure History

---

### 3.7 -- Fallback Routing
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.7-fallback-routing.md
- **Dependencies:** 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/fallback.ts`
- **Acceptance:** Retry with backoff, cross-provider fallback, Telegram alert on fallback; tests pass

#### Notes
- FallbackRouter: standalone `executeWithFallback()` function with DI sleep for testing; non-retryable errors propagate immediately
- isRetryableError detects: rate limit, 429, quota, overloaded, 503, 529, connection, timeout, ECONNRESET, ECONNREFUSED
- OpenAIAdapter (openai 6.33.0) deleted in lean integration overhaul (session 17); replaced by CodexAdapter in task 3.6
- Fallback tests updated: removed OpenAI adapter tests, kept core fallback routing tests
#### Failure History

---

### 3.8 -- Session Monitoring
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.8-session-monitoring.md
- **Dependencies:** 3.5
- **Assigned:** interactive
- **Artifacts:** `src/agents/monitor.ts`
- **Acceptance:** Detects hung sessions (10min), kills and marks FAILED, sends alert; tests pass

#### Notes
- SessionMonitor class with DI (cancelSession, db, sendAlert, now); no new packages
- check() exposed publicly for testable fake-timer approach (setInterval calls it internally)
- Hung session removed from tracking Map before async cleanup to prevent double-handling
- cancelSession errors handled gracefully (session may already be finished)
- 17 new tests, 146 total passing
#### Failure History

---

### 3.9 -- Session Runner + Orchestrator Wiring
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.9-session-runner.md
- **Dependencies:** 3.2, 3.6, 3.7, 3.8
- **Assigned:** interactive
- **Artifacts:** `src/agents/runner.ts`, `src/plan/writer.ts`
- **Acceptance:** Full task lifecycle orchestration, plan writer, index.ts wiring; tests pass

#### Notes
- SessionRunner: DI-based orchestrator with sequential dispatch (drainQueue loop), sandbox lifecycle, fallback routing, monitoring
- Plan writer: line-by-line status replacement; notes inserted before Failure History section
- index.ts wired: database, Telegram, HITL gates, SessionRunner, plan watcher with SIGTERM shutdown
- Added waitForCompletion() to LLMAdapter and CodexAdapter for synchronous session await
- Added optional getLastActivityMs to MonitorDeps for adapter-delegated activity tracking
- 26 new tests (8 plan-writer + 18 runner), 172 total passing
#### Failure History

---

### 3.10 -- Code Review (Claude Reviewer)
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.10-code-review.md
- **Dependencies:** 3.6
- **Assigned:** interactive
- **Artifacts:** `src/review/types.ts`, `src/review/index.ts`, `agents/reviewer/system_prompt.md`
- **Acceptance:** Claude Reviewer session reviews git diff, returns structured findings; tests pass

#### Notes
- ReviewDeps with ReviewExecutor DI for testable session execution; no new packages
- parseReviewResult handles bare JSON, code-fenced JSON, validates verdict/findings/severity
- Runner integration: review after successful coder session, REQUEST_CHANGES → failed, crash → soft pass
- Reviewer uses Sonnet at $0.50 budget cap; workspace diff via git diff origin/branch
- 25 new tests (13 parseReviewResult + 6 runCodeReview + 1 buildReviewPrompt + 5 runner integration), 182 total passing
#### Failure History

---

### 3.11 -- Deploy Gate Wiring
- **Status:** ready
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
- **Status:** ready
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
| 8       | 2026-03-29 | 3.1  | complete | —      | AgentAdapter interface and types: 4-method interface, AgentInput/Output, 3-tier ModelRoster with DEFAULT_ROSTER, barrel export. Fixed fragile test. 38 tests passing. |
| 9       | 2026-03-29 | 3.2  | complete | —      | Coder agent system prompt: headless lifecycle, filesystem access table, hard stops, completion gates, structured result format. Content-only task. |
| 10      | 2026-03-29 | 3.3  | complete | —      | Cost tracking module: PRICING map for 6 models, logUsage/getSessionCost/getDailySpend with DI. 13 new tests, 51 total passing. |
| 11      | 2026-03-29 | 3.4  | complete | —      | Daytona sandbox manager: @daytonaio/sdk 0.158.0, create/get/destroy lifecycle with in-memory Map, DI via SandboxDeps. 12 new tests, 63 total passing. |
| 12      | 2026-03-29 | 3.5  | complete | —      | LLMAdapter wraps Agent SDK query(): session lifecycle, cost tracking, AbortController cancel. 3 packages added (agent-sdk 0.2.87, claude-code 2.1.87, zod 4.3.6). Dockerfile updated for CLI PATH. 20 new tests, 83 total. |
| 13      | 2026-03-29 | 3.6  | complete | —      | Daytona MCP tools: 11 tools (3 file, 1 shell, 7 git) via Agent SDK tool()/createSdkMcpServer(). Path scoping to /workspace/. No new packages. 21 new tests, 104 total. |
| 14      | 2026-03-29 | 3.7  | complete | —      | Fallback routing: executeWithFallback() with exponential backoff (30s/60s/120s), isRetryableError detection. OpenAIAdapter with tool-call loop via DI chatCreate. openai 6.33.0 (0 deps). 25 new tests, 129 total. |
| 15      | 2026-03-29 | 3.8  | complete | —      | Session monitoring: SessionMonitor class tracks active sessions, detects 10min inactivity, cancels hung sessions, updates SQLite to FAILED, sends Telegram alert. DI with fake time for testing. No new packages. 17 new tests, 146 total. |
| 16      | 2026-03-30 | 3.9  | complete | —      | Session runner + orchestrator wiring: SessionRunner with sequential dispatch, plan writer, index.ts wired with all subsystems (db, Telegram, gates, runner, plan watcher, SIGTERM). waitForCompletion on adapters, getLastActivityMs on monitor. No new packages. 26 new tests, 172 total. |
| 17      | 2026-03-30 | 3.4/3.6/3.7 | complete | —  | Lean integration overhaul: removed Daytona SDK (243 packages) and openai package, replaced with local workspaces (git clone /repo) and CodexAdapter (@openai/codex-sdk 0.117.0). LLMAdapter uses cwd instead of mcpServers. Tier-based routing: heavy/standard → Claude Code, light → Codex, cross-provider fallback. Deleted openai-adapter.ts, daytona-tools.ts, tools/index.ts. Updated system prompt, Docker config, pricing. 156 tests passing. |
| 18      | 2026-03-31 | 3.10 | complete | —  | Code review module: ReviewResult/ReviewFinding types, runCodeReview with ReviewExecutor DI, parseReviewResult (bare/fenced JSON), adversarial reviewer system prompt, runner integration (REQUEST_CHANGES → failed, crash → soft pass). No new packages. 25 new tests, 182 total. |
