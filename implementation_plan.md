# OpenPaw -- Implementation Plan

**Project:** OpenPaw
**Current Phase:** Phase 5 -- Observability & Alerting
**Last Updated:** 2026-04-02

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
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.11-deploy-gate.md
- **Dependencies:** 3.9
- **Assigned:** interactive
- **Artifacts:** (modifies existing files)
- **Acceptance:** Deploy-tagged tasks trigger Gate 2 with context; tests pass

#### Notes
- Parser extended: `- **Deploy:** production|staging` tag, propagated through finalizeTask
- Runner: deploy gate step after review, requestApprovalFn DI, assembleDeployContext with diff truncation
- On approved → complete, on denied/timeout → blocked with note
- Deploy gate skipped when: no deploy tag, coder failed, review rejected
- 18 new tests (4 parser + 6 context + 8 runner integration), 200 total passing
#### Failure History

---

### 3.12 -- Restart Recovery
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.12-restart-recovery.md
- **Dependencies:** 3.9
- **Assigned:** interactive
- **Artifacts:** `src/agents/recovery.ts`
- **Acceptance:** Detects orphaned sessions on startup, marks FAILED, resets tasks, alerts; tests pass

#### Notes
- recoverOrphanedSessions with RecoveryDeps DI; getOrphanedSessions DB query added
- Handles sessions without task_id; continues if plan update fails for one task
- Wired in index.ts before plan watcher — no race condition
- Double-run safe: ended_at set on first recovery, so second run finds nothing
- Fixed fragile parser test (ready count was plan-state-dependent)
- 14 new tests (3 DB query + 11 recovery), 214 total passing
#### Failure History

---

### 4.1 -- Expand Model Roster and Provider Types
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.1-model-roster-expansion.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/agents/types.ts`, `src/costs/pricing.ts`
- **Acceptance:** "research" ModelTier, "google" Provider, Gemini pricing in PRICING table; tests pass

#### Notes
- Added "research" to ModelTier, "google" to Provider
- Gemini 3.1 Pro Preview: $2.00/$12.00 per 1M tokens (input/output)
- Gemini 3.1 Flash Lite Preview: $0.25/$1.50 per 1M tokens
- Research roster: gemini-3.1-pro-preview primary, claude-sonnet-4-6 fallback
- 2 new tests (Gemini cost calculations), 216 total passing
#### Failure History

---

### 4.2 -- Gemini Adapter
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.2-gemini-adapter.md
- **Dependencies:** 4.1
- **Assigned:** interactive
- **Artifacts:** `src/agents/gemini-adapter.ts`
- **Acceptance:** GeminiAdapter implements AgentAdapter, spawns Gemini sessions, tracks usage; tests pass

#### Notes
- @google/genai 1.47.0 (4 deps: google-auth-library, p-retry, protobufjs, ws); 0 audit vulnerabilities
- DI via GeminiAdapterDeps: genaiFactory override for testing, optional toolExecutor for function calling
- Mirrors LLMAdapter/CodexAdapter pattern: background runSession, cumulative token tracking, AbortController cancel
- Model mapping: research → gemini-3.1-pro-preview, light → gemini-3.1-flash-lite-preview
- Function calling: generic call/response cycle via toolExecutor DI; no BrowserUse execution (task 4.3)
- 20 new tests, 236 total passing
#### Failure History

---

### 4.3 -- BrowserUse Tool Wrapper
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.3-browseruse-wrapper.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/tools/browseruse.ts`, `src/tools/index.ts`
- **Acceptance:** Cloud-mode BrowserUse wrapper, structured results, Gemini tool declaration export; tests pass

#### Notes
- Cloud-only mode using BrowserUse API v3 (POST /sessions, GET /sessions/{id} polling)
- No new packages — uses built-in fetch; DI via fetchFn for testing
- Content truncation at maxContentLength (default 10000 chars) to prevent token explosion
- Errors returned in BrowserUseResult.error (never throws)
- getBrowserUseToolDeclaration exports Gemini-compatible FunctionDeclaration (browse_url with url + optional action)
- 13 new tests, 249 total passing
#### Failure History

---

### 4.4 -- Researcher Agent System Prompt
- **Status:** complete
- **Type:** content
- **Contract:** contracts/4.4-researcher-system-prompt.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `agents/researcher/system_prompt.md`
- **Acceptance:** System prompt with anti-sycophancy focus, research methodology, citation requirements, depth awareness

#### Notes
- 5-rule anti-sycophancy core directive + 5-step adversarial self-check before finalization
- 3-phase methodology: broad survey → deep investigation (triangulation, 3-tier source reliability) → synthesis
- Depth-awareness table (1–10) with source count and scope guidance per level
- Structured output: executive summary, sections with confidence levels (high/medium/low), open questions, numbered sources
- Filesystem: research/* read-write only; no access to src/*, secrets, or plan modification
- Content-only task; no code changes
#### Failure History

---

### 4.5 -- Research Types and Contract Template
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.5-research-types.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/research/types.ts`, `src/research/index.ts`, `contracts/_research_template.md`
- **Acceptance:** ResearchBrief/Section/Source types, DepthConfig map, research contract template; tests pass

#### Notes
- ResearchBrief/Section/Source types with SourceReliability and confidence levels
- DEPTH_CONFIGS: 10 levels with increasing token budgets (1.5K–60K), source minimums (1–12), and cost ranges ($0.05–$12)
- parseResearchBrief: extracts structured data from markdown (sections, confidence, citations, sources)
- Research contract template at contracts/_research_template.md
- No new packages; 16 new tests, 265 total passing
#### Failure History

---

### 4.6 -- Research Fact-Check Reviewer
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.6-research-reviewer.md
- **Dependencies:** 4.5
- **Assigned:** interactive
- **Artifacts:** `agents/researcher-reviewer/system_prompt.md`, `src/review/research.ts`
- **Acceptance:** Adversarial fact-checking prompt, runResearchReview function, reuses ReviewResult types; tests pass

#### Notes
- Adversarial system prompt: fabricated claims (critical), unsupported assertions (major), weak sourcing (minor), cross-model diversity emphasis
- runResearchReview mirrors runCodeReview: ReviewExecutor DI, session/cost logging, soft pass on failure
- Reuses parseReviewResult and ReviewResult/ReviewFinding types from src/review/index.ts (no duplication)
- buildResearchReviewPrompt wraps brief in markdown fence
- No new packages; 11 new tests, 276 total passing
#### Failure History

---

### 4.7 -- Research Session Runner
- **Status:** complete
- **Type:** code
- **Contract:** contracts/4.7-research-runner.md
- **Dependencies:** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
- **Assigned:** interactive
- **Artifacts:** `src/research/runner.ts`, `src/research/estimator.ts`
- **Acceptance:** Full research orchestration: cost estimate, Researcher session, Reviewer fact-check, Gate 3 approval; tests pass

#### Notes
- ResearchRunner: DI-based orchestrator with cost estimation → spend gate → Gemini researcher → fact-check review → research gate lifecycle
- Cost estimation uses DEPTH_CONFIGS table directly (no Haiku pre-flight call); estimateCostFn DI for future LLM-based estimation
- Gemini primary with BrowserUse toolExecutor; Claude Sonnet fallback via Agent SDK (no BrowserUse in fallback)
- GeminiAdapter extended with getResultText() to expose session output for brief extraction
- assembleBriefContext formats task/cost/review/brief preview for Gate 3 approval messages
- No new packages; 20 new tests (10 estimator + 10 runner), 306 total passing
#### Failure History

---

### 4.8 -- Docker and Secrets Configuration
- **Status:** complete
- **Type:** infrastructure
- **Contract:** contracts/4.8-docker-secrets.md
- **Dependencies:** 4.7
- **Assigned:** interactive
- **Artifacts:** `docker-compose.yml`, `src/index.ts`
- **Acceptance:** Gemini and BrowserUse secrets wired, ResearchRunner instantiated at startup; Docker build succeeds

#### Notes
- browseruse_cloud_api_key added to docker-compose.yml secrets
- ResearchRunner instantiated before code SessionRunner; graceful degradation if gemini_api_key missing
- SIGTERM handler includes researchRunner?.stop() in both branches (with/without anthropic key)
- No new packages; Docker build verified; 306 tests passing
#### Failure History

---

### 5.1 -- Structured Alert System
- **Status:** complete
- **Type:** code
- **Contract:** contracts/5.1-structured-alerts.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/alerts/types.ts`, `src/alerts/formatter.ts`, `src/alerts/index.ts`
- **Acceptance:** AlertType union, AlertPayload discriminated union, AlertSystem class with dedicated channel support; tests pass

#### Notes
- AlertType union (7 types), AlertPayload discriminated union with per-type fields, AlertDeps interface
- formatAlertMessage produces HTML: emoji header, bold field labels, arrow footer — matches design doc Section 5 format
- AlertSystem class routes to alertsChatId when provided, falls back to fallbackChatId
- Replicates escapeHtml pattern from src/messaging/telegram.ts (not imported to avoid coupling)
- No new packages; 14 new tests, 320 total passing
#### Failure History

---

### 5.2 -- Budget Controls
- **Status:** complete
- **Type:** code
- **Contract:** contracts/5.2-budget-controls.md
- **Dependencies:** 5.1
- **Assigned:** interactive
- **Artifacts:** `src/budget/types.ts`, `src/budget/index.ts`
- **Acceptance:** BudgetEnforcer with 80% warning and 100% hard stop; wired into SessionRunner and ResearchRunner; tests pass

#### Notes
- BudgetEnforcer with checkBudget() and enforceBudget() methods; DI via BudgetEnforcerDeps
- Warn-once: tracks lastWarningDate to avoid duplicate 80% alerts per calendar day
- Hard stop: sends budget_hard_stop alert, then requests spend gate; returns gate decision
- SessionRunner.drainQueue: budget check before each dispatch; breaks loop on false
- ResearchRunner.runResearch: budget check before cost estimation step
- budgetEnforcer is optional in both RunnerDeps and ResearchRunnerDeps (existing tests unaffected)
- No new packages; 16 new tests, 336 total passing
#### Failure History

---

### 5.3 -- Stuck Task Detection
- **Status:** complete
- **Type:** code
- **Contract:** contracts/5.3-stuck-task-detection.md
- **Dependencies:** 5.1
- **Assigned:** interactive
- **Artifacts:** (modifies existing files)
- **Acceptance:** 3+ failures pauses dispatch for task, sends stuck_task alert; tests pass

#### Notes
- getTaskFailureCount queries sessions table for both 'failed' and 'FAILED' terminal states
- SessionRunner.stuckTasks Set tracks tasks at 3+ failures; resets on construction (intentional restart behavior)
- drainQueue skips stuck tasks with log message; non-stuck tasks dispatch normally
- stuck_task alert via optional alertSystem field on RunnerDeps (null-safe)
- No new packages; 12 new tests, 348 total passing
#### Failure History

---

### 5.4 -- Laminar Tracing Integration
- **Status:** complete
- **Type:** code
- **Contract:** contracts/5.4-laminar-tracing.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** `src/tracing/index.ts`, `src/tracing/sanitize.ts`
- **Acceptance:** Laminar SDK wraps session execution, secret sanitization, graceful no-op without key; tests pass

#### Notes
- @lmnr-ai/lmnr 0.8.15 (118 transitive packages — heavy due to OpenTelemetry + instrumentations); 0 audit vulnerabilities
- initTracing/traceSession/shutdownTracing with no-op fallback when laminar_api_key absent
- scrubSecrets replaces secret values >= 4 chars with [REDACTED]
- SessionRunner.executeSession wrapped in traceSession with coder metadata
- ResearchRunner.executeDefaultResearch wrapped in traceSession with researcher metadata
- Dynamic import via require() for resilient no-op when SDK missing; tracing errors caught, never propagated
- 13 new tests, 361 total passing
#### Failure History

---

### 5.5 -- SQL Cost Views
- **Status:** complete
- **Type:** code
- **Contract:** contracts/5.5-sql-cost-views.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** (modifies existing files)
- **Acceptance:** 3 SQL views created during init, TypeScript query wrappers; tests pass

#### Notes
- Three SQL views: daily_spend_by_service, monthly_spend_by_agent, most_expensive_sessions
- Views created via CREATE VIEW IF NOT EXISTS in schema.sql; works with existing initDatabase flow
- TypeScript wrappers: getDailySpendByService (optional date filter), getMonthlySpendByAgent, getMostExpensiveSessions (configurable limit, default 10)
- No new packages; 12 new tests, 373 total passing
#### Failure History

---

### 5.6 -- Docker Wiring, Decision Logging, and Failure Mode Verification
- **Status:** ready
- **Type:** infrastructure
- **Contract:** contracts/5.6-docker-wiring-verification.md
- **Dependencies:** 5.1, 5.2, 5.3, 5.4, 5.5
- **Assigned:** interactive
- **Artifacts:** (modifies existing files)
- **Acceptance:** All Phase 5 modules wired in index.ts, decision logging in gates, new Docker secrets, Docker build succeeds; tests pass

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
| 19      | 2026-03-31 | 3.11 | complete | —  | Deploy gate wiring: parser extended with deploy tag, runner calls requestApproval for deploy-tagged tasks, assembleDeployContext with diff/review/session summary. Approved → complete, denied/timeout → blocked. No new packages. 18 new tests, 200 total. |
| 20      | 2026-03-31 | 3.12 | complete | —  | Restart recovery: getOrphanedSessions DB query, recoverOrphanedSessions resets tasks to ready and marks sessions FAILED. Wired in index.ts before plan watcher. Fixed fragile parser test. No new packages. 14 new tests, 214 total. |
| 21      | 2026-03-31 | —    | complete | —  | Phase 4 scaffolding: wrote 8 contracts (4.1-4.8), added Phase 4 task entries to implementation plan, updated current phase. Fixed stale OpenAIAdapter refs in 3.7 contract. Updated project_spec.md (Daytona/Cubic → local workspaces/Claude Reviewer). 214 tests passing. |
| 22      | 2026-03-31 | 4.1  | complete | —  | Model roster expansion: "research" ModelTier, "google" Provider, Gemini 3.1 Pro/Flash Lite pricing. Research roster: Gemini primary, Sonnet fallback. 2 new tests, 216 total. |
| 23      | 2026-04-01 | 4.2  | complete | —  | Gemini adapter: GeminiAdapter implements AgentAdapter with @google/genai 1.47.0. Streaming via generateContentStream, cumulative token tracking, function calling cycle with toolExecutor DI. No runner modifications. 20 new tests, 236 total. |
| 24      | 2026-04-01 | 4.3  | complete | —  | BrowserUse Cloud wrapper: browseUrl with API v3 session create/poll, getBrowserUseToolDeclaration for Gemini function calling. Content truncation, error-in-result pattern. No new packages. 13 new tests, 249 total. |
| 25      | 2026-04-01 | 4.4  | complete | —  | Researcher agent system prompt: anti-sycophancy directives, 3-phase methodology, depth-aware scoping (1–10), citation requirements, adversarial self-check. Content-only task. |
| 26      | 2026-04-01 | 4.5  | complete | —  | Research types: ResearchBrief/Section/Source, DEPTH_CONFIGS (10 levels), parseResearchBrief parser, research contract template. No new packages. 16 new tests, 265 total. |
| 27      | 2026-04-01 | 4.6  | complete | —  | Research fact-check reviewer: adversarial system prompt, runResearchReview with ReviewExecutor DI, reuses parseReviewResult. No new packages. 11 new tests, 276 total. |
| 28      | 2026-04-02 | 4.7/4.8 | complete | —  | Research runner + Docker wiring: ResearchRunner orchestrates cost estimate→spend gate→Gemini researcher→fact-check review→research gate lifecycle. Cost estimator uses DEPTH_CONFIGS. GeminiAdapter.getResultText() for brief extraction. Gemini primary, Claude Sonnet Agent SDK fallback. browseruse_cloud_api_key added to Docker secrets. ResearchRunner wired in index.ts with graceful degradation. No new packages. 30 new tests, 306 total. |
| 29      | 2026-04-02 | —    | complete | —  | Phase 5 scaffolding: wrote 6 contracts (5.1-5.6), added Phase 5 task entries to implementation plan, updated current phase. Fixed fragile parser test (hardcoded task count → invariant-based). 306 tests passing. |
| 30      | 2026-04-02 | 5.1  | complete | —  | Structured alert system: AlertType union (7 types), AlertPayload discriminated union, formatAlertMessage (HTML with emoji/bold/footer), AlertSystem class with dedicated alertsChatId + fallbackChatId routing. No new packages. 14 new tests, 320 total. |
| 31      | 2026-04-02 | 5.2  | complete | —  | Budget controls: BudgetEnforcer with checkBudget/enforceBudget, warn-once at 80%, hard stop at 100% with spend gate. Integrated into SessionRunner.drainQueue and ResearchRunner.runResearch as optional field. No new packages. 16 new tests, 336 total. |
| 32      | 2026-04-02 | 5.3  | complete | —  | Stuck task detection: getTaskFailureCount DB query, stuckTasks Set in SessionRunner, drainQueue skip with log, stuck_task alert via optional alertSystem. No new packages. 12 new tests, 348 total. |
| 33      | 2026-04-02 | 5.4  | complete | —  | Laminar tracing: @lmnr-ai/lmnr 0.8.15, initTracing/traceSession/shutdownTracing with no-op fallback, scrubSecrets sanitization. SessionRunner and ResearchRunner wrapped with trace metadata. 13 new tests, 361 total. |
| 34      | 2026-04-02 | 5.5  | complete | —  | SQL cost views: daily_spend_by_service, monthly_spend_by_agent, most_expensive_sessions in schema.sql. TypeScript query wrappers in db/index.ts. No new packages. 12 new tests, 373 total. |
