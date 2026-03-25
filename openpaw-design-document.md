Mission Control: Technical Design Document

  ---
  1. System Architecture

  Component Diagram

  graph TB
      subgraph MacMini["Mac Mini — Gateway + Orchestrator"]
          NC["NanoClaw daemon<br/>(Node/Bun, Docker)"]
          DB["SQLite<br/>sessions.db"]
          Git["Git repo<br/>Persistent artifacts"]
          CC["Claude Code CLI<br/>(interactive sessions)"]
      end

      subgraph Providers["LLM Providers"]
          Anth["Anthropic API<br/>Sonnet 4.6 / Opus 4.6"]
          OAI["OpenAI API<br/>GPT-5.4 / Codex 5.3"]
          Gem["Gemini API<br/>Gemini 3.1 Pro"]
      end

      subgraph DevInfra["Dev Infrastructure"]
          Day["Daytona<br/>sandboxed code execution"]
          Ver["Vercel<br/>deploy target"]
          Cub["Cubic<br/>PR auto-review"]
          T21["21st.dev<br/>UI components"]
      end

      subgraph BrowserAuto["Browser Automation"]
          BU["BrowserUse CLI 2<br/>direct CDP, dual-mode"]
      end

      subgraph Research["Research Infrastructure"]
          Ded["Dedalus Labs<br/>hosted MCP servers"]
      end

      subgraph Obs["Observability"]
          Lam["Laminar<br/>tracing"]
      end

      subgraph Msg["Human Interface"]
          TG["Telegram / Slack"]
      end

      NC <--> DB
      NC <--> Git
      CC <--> Git
      NC --> Anth
      NC --> OAI
      NC --> Gem
      CC --> Anth
      NC --> Day
      NC --> Ver
      NC --> Cub
      NC --> T21
      NC --> BU
      NC --> Ded
      NC --> Lam
      NC <--> TG

  Key architectural constraint: The Mac Mini runs NanoClaw (orchestration) and Claude Code (interactive). All
  LLM inference happens on remote APIs. All code execution for headless sessions happens on Daytona. The Mac
  Mini never bears compute load beyond orchestration.

  Data Flow: W1 — Coding Projects

  sequenceDiagram
      participant H as Human
      participant CC as Claude Code
      participant NC as NanoClaw
      participant Plan as implementation_plan.md
      participant Day as Daytona
      participant Cub as Cubic
      participant Ver as Vercel

      H->>CC: New project requirements
      CC->>Plan: Create project_spec.md + implementation_plan.md
      CC->>H: Review plan
      H->>Plan: Approve (edit if needed)

      loop For each ready task
          NC->>Plan: Read, find next ready task
          alt Complex / architectural
              NC->>H: Notify: task ready (Telegram)
              H->>CC: Work interactively (Opus)
              CC->>Plan: Update task status
          else Well-specified, low-risk
              NC->>Day: Spawn headless Coder (Sonnet)
              Day->>Day: Execute in sandbox
              Day->>Plan: Update task status
              Day->>Cub: Open PR
              Cub->>Plan: Auto-review findings
              alt High-risk task
                  NC->>Day: Spawn Reviewer session
                  Day->>Plan: Review findings
              end
          end
          alt Task includes deploy
              NC->>H: Deploy approval (HITL)
              H->>NC: Approve
              NC->>Ver: Deploy
          end
      end

  Data Flow: W2 — Deep Research

  sequenceDiagram
      participant H as Human
      participant NC as NanoClaw
      participant Plan as implementation_plan.md
      participant Gem as Gemini API
      participant BU as BrowserUse
      participant Out as research/*.md

      H->>Plan: Create research task/contract
      NC->>Plan: Read, find research task
      NC->>Gem: Spawn Researcher session
      Gem->>BU: Complex web interactions
      BU->>Gem: Page content
      Gem->>Gem: Synthesize sources
      Gem->>Out: Write research brief
      Gem->>Plan: Update task status
      NC->>NC: Spawn Reviewer (Sonnet)
      NC->>Plan: Fact-check findings
      NC->>H: Research brief ready (HITL)
      H->>H: Review + approve

  Data Flow: W3 — Web App Building

  W3 follows W1's flow with two additions:
  - UI generation: Coder sessions call 21st.dev API to generate components during implementation. This is a
  tool call within the Coder's task, not a separate agent interaction.
  - Dev environments: Daytona serves double duty — sandboxing headless code execution AND providing a
  persistent dev environment for the sprint. The Coder session connects to the Daytona environment, makes
  changes, and the environment persists between sessions.

  No separate sequence diagram needed — the difference is which tools the Coder invokes, not the flow
  structure.

  State Management

  Two state stores. No more.

  1. Git repo (source of truth)

  All persistent artifacts live in a git repo on the Mac Mini. This includes:

  project-root/
  ├── project_spec.md
  ├── implementation_plan.md
  ├── contracts/
  │   └── *.md
  ├── research/
  │   └── *.md
  ├── src/                        # Project source code
  ├── tests/
  └── CLAUDE.md                   # Execution lifecycle rules

  Every session's artifact updates are committed to git. This gives:
  - Full history of every artifact change
  - Revert capability for any corruption
  - Diff visibility for plan changes
  - Blame for tracing which session changed what

  2. SQLite database (operational metadata)

  NanoClaw maintains ~/.nanoclaw/sessions.db for data that doesn't belong in the project repo:

  CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,           -- planner|coder|researcher|reviewer
      task_id TEXT,                  -- reference to plan task
      model TEXT NOT NULL,           -- actual model used
      provider TEXT NOT NULL,        -- anthropic|openai|google
      started_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP,
      terminal_state TEXT,           -- COMPLETE|BLOCKED|FAILED|DEFERRED
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      error TEXT                     -- null on success
  );

  CREATE TABLE hitl_gates (
      id TEXT PRIMARY KEY,
      gate_type TEXT NOT NULL,       -- plan|deploy|research|spec_change|spend
      task_id TEXT,
      session_id TEXT REFERENCES sessions(id),
      requested_at TIMESTAMP NOT NULL,
      decided_at TIMESTAMP,
      decision TEXT,                 -- approved|rejected|timeout
      context_summary TEXT           -- what was shown to human
  );

  CREATE TABLE cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      service TEXT NOT NULL,         -- anthropic|openai|google|browseruse|...
      amount_usd REAL NOT NULL,
      logged_at TIMESTAMP NOT NULL
  );

  Why SQLite, not Postgres or Redis: Single writer (NanoClaw), single reader (NanoClaw + dashboards).
  File-based, zero external dependencies, survives process restart, trivial to back up (cp the file). At these
  volumes (<100 sessions/month), SQLite is not even close to being a bottleneck.

  DEFERRED: Multi-project support. Current design assumes one active project per repo. Supporting multiple
  concurrent projects requires either separate repos (simple) or a project_id dimension in the plan schema.
  Defer until the need is demonstrated.

  Agent Abstraction Layer

  NanoClaw orchestrates two kinds of agents through a uniform interface:

  1. LLM-native agents — Planner, Coder, Researcher, Reviewer, and LLM-based custom agents. These run as
     API sessions against LLM providers (Anthropic, OpenAI, Google). NanoClaw manages the session lifecycle
     via the Agents SDK or direct API calls.

  2. External service agents — standalone services with their own APIs (e.g., a calendar agent, a social
     media posting service). NanoClaw triggers them via HTTP and monitors their status.

  Both types implement the same interface from NanoClaw's perspective:

  interface AgentAdapter {
    trigger(input: AgentInput): Promise<string>        // returns session_id
    status(sessionId: string): Promise<AgentStatus>    // running | complete | failed | waiting_hitl
    output(sessionId: string): Promise<AgentOutput>    // retrieve results/artifacts
    cancel(sessionId: string): Promise<void>           // abort a running session
  }

  Two adapter implementations:

  LLMAdapter
    - Wraps Agents SDK / direct API calls
    - Manages model selection, fallback chains, token tracking
    - Used by: Planner, Coder, Researcher, Reviewer, LLM-based custom agents

  ServiceAdapter
    - Wraps HTTP calls to external service APIs
    - Config per agent: base_url, auth (API key or OAuth token), health_check endpoint
    - Polls status via GET or receives webhook callbacks
    - Used by: calendar agent, future social media posting services, any standalone service

  Agent definition files (agents/<name>/agent.md) gain a new field:

  ## Adapter
  type: service                          # "llm" (default) or "service"
  base_url: http://localhost:8100
  auth: bearer ${CALENDAR_AGENT_TOKEN}   # references secrets.env
  health_check: /health
  trigger_endpoint: POST /tasks
  status_endpoint: GET /tasks/{session_id}
  output_endpoint: GET /tasks/{session_id}/output

  For LLM agents, the adapter section is optional (defaults to type: llm with model/provider from Identity).

  HITL gates, cost tracking, scheduling, and output routing all operate above the adapter layer — they work
  identically regardless of whether the underlying agent is an LLM session or an HTTP service.

  ---
  2. Sandboxing & Security

  Container Strategy

  ┌─────────────────────────────────────────────────────────┐
  │ Mac Mini                                                │
  │                                                         │
  │  ┌──────────────────┐  ┌──────────────────────────────┐ │
  │  │  Docker:          │  │  Host:                       │ │
  │  │  NanoClaw         │  │  Claude Code CLI             │ │
  │  │  (orchestration)  │  │  (interactive, human present)│ │
  │  └──────┬───────────┘  └──────────────────────────────┘ │
  │         │                                               │
  │         ├── API calls → LLM providers (remote)          │
  │         ├── API calls → Daytona (remote code execution) │
  │         ├── API calls → External services               │
  │         └── File I/O → Git repo (mounted volume)        │
  └─────────────────────────────────────────────────────────┘

  - NanoClaw runs in a Docker container. Mounted volumes: git repo (read-write), secrets (read-only), SQLite
  data dir (read-write).
  - Claude Code runs on the host. Human is present and uses Claude Code's built-in approval modes for
  permission control.
  - Headless code execution happens on Daytona, not on the Mac Mini. NanoClaw sends instructions via Daytona's
  API; the actual file writes, shell commands, and builds run in Daytona's sandboxed environments.
  - Research sessions make API calls only (Gemini, BrowserUse). No local code execution.

  Filesystem Access Matrix

  ┌──────────┬────────┬───────────────┬─────────────────────┬───────────┬──────────┬──────────┬────────┐
  │  Agent   │  Git   │ project_spec. │ implementation_plan │ contracts │  src/*   │ research │ secret │
  │          │  repo  │      md       │         .md         │    /*     │          │    /*    │   s    │
  ├──────────┼────────┼───────────────┼─────────────────────┼───────────┼──────────┼──────────┼────────┤
  │ Planner  │ mounte │ read          │ read-write          │ read-writ │ none     │ none     │ none   │
  │          │ d      │               │                     │ e         │          │          │        │
  ├──────────┼────────┼───────────────┼─────────────────────┼───────────┼──────────┼──────────┼────────┤
  │ Coder    │ via Da │ read          │ read-write          │ read      │ read-wri │ none     │ none   │
  │          │ ytona  │               │                     │           │ te       │          │        │
  ├──────────┼────────┼───────────────┼─────────────────────┼───────────┼──────────┼──────────┼────────┤
  │ Research │ mounte │ read          │ read-write          │ read      │ none     │ read-wri │ none   │
  │ er       │ d      │               │                     │           │          │ te       │        │
  ├──────────┼────────┼───────────────┼─────────────────────┼───────────┼──────────┼──────────┼────────┤
  │ Reviewer │ mounte │ read          │ read-write          │ read      │ read-onl │ read     │ none   │
  │          │ d      │               │                     │           │ y        │          │        │
  └──────────┴────────┴───────────────┴─────────────────────┴───────────┴──────────┴──────────┴────────┘

  Enforcement mechanism: NanoClaw configures each agent session's tool definitions to only include file
  operations for allowed paths. The Agents SDK tool definitions explicitly enumerate allowed directories. For
  Daytona, the dev environment is cloned from the repo with the appropriate access.

  Network Access Matrix

  ┌────────────┬─────────────────┬────────┬─────────┬──────────┬────────────┬───────┬──────────┬──────────┐
  │   Agent    │     LLM API     │ Vercel │ Daytona │ 21st.dev │ BrowserUse │ Cubic │ Dedalus  │ General  │
  │            │                 │        │         │          │  CLI/Cloud │       │   MCP    │   web    │
  ├────────────┼─────────────────┼────────┼─────────┼──────────┼────────────┼───────┼──────────┼──────────┤
  │ Planner    │ Anthropic       │ —      │ —       │ —        │ —          │ —     │ —        │ —        │
  ├────────────┼─────────────────┼────────┼─────────┼──────────┼────────────┼───────┼──────────┼──────────┤
  │ Coder      │ Anthropic,      │ ✓      │ ✓       │ ✓        │ ✓          │ ✓     │ —        │ —        │
  │            │ OpenAI          │        │         │          │            │       │          │          │
  ├────────────┼─────────────────┼────────┼─────────┼──────────┼────────────┼───────┼──────────┼──────────┤
  │            │ Gemini,         │        │         │          │            │       │          │          │
  │ Researcher │ Anthropic,      │ —      │ —       │ —        │ ✓          │ —     │ ✓        │ ✓        │
  │            │ OpenAI          │        │         │          │            │       │          │          │
  ├────────────┼─────────────────┼────────┼─────────┼──────────┼────────────┼───────┼──────────┼──────────┤
  │ Reviewer   │ Anthropic,      │ —      │ —       │ —        │ —          │ ✓     │ —        │ —        │
  │            │ Gemini          │        │         │          │            │       │          │          │
  ├────────────┼─────────────────┼────────┼─────────┼──────────┼────────────┼───────┼──────────┼──────────┤
  │ Custom     │ Configurable    │ —      │ —       │ —        │ ✓          │ —     │ —        │ ✓        │
  │            │                 │        │         │          │            │       │          │          │
  └────────────┴─────────────────┴────────┴─────────┴──────────┴────────────┴───────┴──────────┴──────────┘

  BrowserUse access note: BrowserUse is a general-purpose tool. Coder uses it for web UI testing and
  verification. Researcher uses it for source browsing. Custom agents can be granted access via their agent
  definition. Planner and Reviewer don't need browser access.

  Enforcement: NanoClaw's Docker container uses network rules to restrict outbound connections per agent
  session. In practice, since agents operate via API calls through NanoClaw, the enforcement is at the tool
  definition layer — agents only see the tools they're given.

  Secret Management

  - API keys stored in ~/.nanoclaw/secrets.env, mounted read-only into NanoClaw's container.
  - NanoClaw injects only the keys each agent needs into its session context. The Researcher never sees the
  Vercel deploy token. Agents without BrowserUse access never see the BrowserUse Cloud API key.
  - Git repo .gitignore includes secrets.env, sessions.db, and any .env files.
  - DEFERRED: Automated key rotation. Manual rotation for now. At 4 agents and ~12 keys, manual is manageable.
  Automate when the key count or team size justifies it.

  Blast Radius Analysis

  ┌────────────┬─────────────────┬────────────────────┬────────────────────────────────────┬──────────────┐
  │   Agent    │ Worst case if   │    Blast radius    │             Mitigation             │   Recovery   │
  │            │      rogue      │                    │                                    │              │
  ├────────────┼─────────────────┼────────────────────┼────────────────────────────────────┼──────────────┤
  │            │ Corrupts plan,  │ Plan + contracts   │ HITL plan approval gate. All       │              │
  │ Planner    │ creates bogus   │ (no code)          │ artifacts in git.                  │ git revert   │
  │            │ tasks           │                    │                                    │              │
  ├────────────┼─────────────────┼────────────────────┼────────────────────────────────────┼──────────────┤
  │            │ Writes          │                    │ Daytona sandbox (code isolated     │ git revert + │
  │ Coder      │ malicious code, │ Code + production  │ from Mac Mini). Cubic auto-review  │  vercel      │
  │            │  deploys it     │ deployment         │ catches obvious issues. HITL       │ rollback     │
  │            │                 │                    │ deploy gate blocks production.     │              │
  ├────────────┼─────────────────┼────────────────────┼────────────────────────────────────┼──────────────┤
  │            │ Produces        │ Research briefs    │ Reviewer fact-check. HITL research │ Delete       │
  │ Researcher │ fabricated      │ (no code)          │  approval.                         │ brief,       │
  │            │ research        │                    │                                    │ re-run       │
  ├────────────┼─────────────────┼────────────────────┼────────────────────────────────────┼──────────────┤
  │            │ Approves bad    │ Plan status only   │ Human is final gate for            │ Re-run       │
  │ Reviewer   │ work or rejects │ (no code           │ high-stakes decisions.             │ review       │
  │            │  good work      │ modification)      │                                    │              │
  └────────────┴─────────────────┴────────────────────┴────────────────────────────────────┴──────────────┘

  ┌────────────┬─────────────────┬────────────────────┬────────────────────────────────────┬──────────────┐
  │ External   │ Sends unwanted  │ External           │ Gate 6 (External Communication)    │ Revoke       │
  │ Service    │ communications, │ communications +   │ blocks all outbound content.        │ service API  │
  │ Agent      │ drains external │ external service   │ ServiceAdapter health checks detect │ keys.        │
  │            │ service quotas  │ quota              │ runaway agents. Budget gate (Gate 5)│ Review       │
  │            │                 │                    │ limits spend.                       │ sent items   │
  └────────────┴─────────────────┴────────────────────┴────────────────────────────────────┴──────────────┘

  Most dangerous scenario: Headless Coder deploys bad code to production. This requires:
  1. Coder writes bad code (possible)
  2. Tests pass despite bad code (possible if tests are weak)
  3. Cubic misses the issue (possible for logic bugs)
  4. Reviewer is skipped (only happens for low-risk tasks)
  5. Human approves deploy without reviewing (human error)

  Steps 4 and 5 cannot both happen for production deploys — the deploy gate is mandatory and never
  auto-approved for production. The realistic worst case is: bad code reaches staging, is caught during deploy
  review, and reverted. Cost: one wasted Coder session + one deploy review cycle.

  ---
  2b. BrowserUse CLI — General-Purpose Browser Automation

  BrowserUse CLI 2 is a general-purpose browser automation tool that uses direct ChromeDevTools Protocol
  (CDP) — not Playwright. Any NanoClaw agent can invoke it as a subprocess when it needs browser interaction.

  Dual-Mode Architecture

  NanoClaw provides BrowserUse in two modes. Agent definitions specify which mode to use:

  1. CLI mode (local)
     - BrowserUse CLI installed on the Mac Mini: curl -fsSL https://browser-use.com/cli/install.sh | bash
     - Agents invoke it as a subprocess: browser-use open <url>, browser-use state, etc.
     - Direct CDP connection to a local Chromium instance
     - Free (no API credits consumed)
     - Best for: quick interactions, local web UI testing, lightweight browsing tasks

  2. Cloud API mode (remote)
     - HTTP calls to BrowserUse Cloud infrastructure
     - Browser runs remotely — no local Chromium needed
     - Consumes BrowserUse Cloud credits ($1,000+ available)
     - Best for: heavy research sessions, parallel browsing, long-running scraping, complex multi-page flows

  Agent definitions configure BrowserUse access:

  ## Tools
  - browseruse:
      mode: cli                    # cli | cloud | both
      headless: true               # default true (CLI mode only)

  When mode is "both", NanoClaw selects the mode based on task context: CLI for quick/local tasks,
  Cloud for heavy/parallel tasks. The selection heuristic is configurable per agent.

  Integration Pattern

  NanoClaw wraps BrowserUse in a tool definition that agents can invoke. The wrapper:
  - Selects CLI or Cloud mode based on agent config
  - For CLI: spawns browser-use as a subprocess, captures structured output
  - For Cloud: makes HTTP calls to BrowserUse Cloud API with the Cloud API key from secrets.env
  - Returns structured results (page content, screenshots, element state) to the agent

  This makes BrowserUse a first-class tool alongside file I/O, web search, and code execution — any
  agent with BrowserUse access can control a browser when its task requires it.

  ---
  3. HITL Approval Gates

  Gate 1: Plan Approval

  ┌─────────────────┬──────────────────────────────────────────────────────────────────────────────────────┐
  │                 │                                                                                      │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger         │ Planner session completes a new implementation_plan.md or performs a major re-plan   │
  │                 │ (>3 tasks added/modified).                                                           │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to    │ Full plan diff (git diff). Summary of tasks added, removed, or modified. Dependency  │
  │ human           │ graph of ready tasks.                                                                │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Delivery        │ Telegram/Slack message with plan summary + link to full diff in git.                 │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout         │ No timeout. Plan sits until reviewed. Zero implementation sessions are dispatched    │
  │ behavior        │ until this gate clears.                                                              │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Override policy │ Never auto-approved. This is the highest-leverage gate — a bad plan wastes every     │
  │                 │ downstream session.                                                                  │
  └─────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘

  Gate 2: Deploy Approval

  ┌───────────────┬────────────────────────────────────────────────────────────────────────────────────────┐
  │               │                                                                                        │
  ├───────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger       │ Coder session completes a task tagged deploy: production in the plan.                  │
  ├───────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to  │ Git diff of all changes since last deploy. Test results (pass/fail count, any          │
  │ human         │ failures). Cubic review summary. Target environment (staging vs. production).          │
  ├───────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
  │ Delivery      │ Telegram/Slack message with summary. Full diff available via git.                      │
  ├───────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout       │ 24 hours. Session terminates as BLOCKED with "awaiting deploy approval." Task remains  │
  │ behavior      │ ready for the next session after approval.                                             │
  ├───────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
  │ Override      │ Auto-approve allowed for deploy: staging only. Production is never auto-approved.      │
  │ policy        │                                                                                        │
  └───────────────┴────────────────────────────────────────────────────────────────────────────────────────┘

  Gate 3: Research Brief Approval

  ┌────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
  │                │                                                                                       │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger        │ Reviewer session completes fact-check of a research brief.                            │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to   │ Research brief. Reviewer findings (factual issues, source quality, gaps). Pass/fail   │
  │ human          │ assessment.                                                                           │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Delivery       │ Telegram/Slack message with summary + link to full brief.                             │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout        │ No timeout. Brief is not delivered or marked complete until approved.                 │
  │ behavior       │                                                                                       │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Override       │ Auto-approve configurable: if Reviewer found zero issues and all sources verified,    │
  │ policy         │ can be set to auto-approve. Default: manual.                                          │
  └────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘

  Gate 4: Spec Change

  ┌─────────────────┬──────────────────────────────────────────────────────────────────────────────────────┐
  │                 │                                                                                      │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger         │ Any session determines that project_spec.md requires modification.                   │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to    │ Proposed change (exact diff). Rationale. Impact assessment: which planned tasks are  │
  │ human           │ affected.                                                                            │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Delivery        │ Telegram/Slack message.                                                              │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout         │ No timeout. Spec change requires explicit human decision. The session that           │
  │ behavior        │ discovered the need terminates as BLOCKED.                                           │
  ├─────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Override policy │ Never auto-approved.                                                                 │
  └─────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘

  Gate 5: Spend Threshold

  ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
  │              │                                                                                         │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger      │ NanoClaw detects a single session has consumed >$10 USD, OR cumulative daily spend      │
  │              │ across all sessions exceeds $50 USD.                                                    │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to │ Current session cost breakdown (tokens, model, service). Daily total across sessions.   │
  │  human       │ Projected burn at current rate.                                                         │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Delivery     │ Telegram/Slack alert.                                                                   │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout      │ Per-session: session continues but human is notified. Daily: all headless sessions      │
  │ behavior     │ paused until human acknowledges. Interactive sessions (Claude Code) are unaffected      │
  │              │ since human is present.                                                                 │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Override     │ Thresholds are configurable. Can be raised or lowered. Can be disabled for specific     │
  │ policy       │ sessions (e.g., a known-expensive research brief).                                      │
  └──────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

  Gate 6: External Communication

  ┌────────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
  │                │                                                                                       │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Trigger        │ Any agent attempts to send a message outside the system (email, Slack to external     │
  │                │ channels, social media, client-facing communication).                                 │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Presented to   │ Full message content. Recipient(s). Context (which task triggered it).                │
  │ human          │                                                                                       │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Timeout        │ No timeout. Message held until approved.                                              │
  │ behavior       │                                                                                       │
  ├────────────────┼───────────────────────────────────────────────────────────────────────────────────────┤
  │ Override       │ Never auto-approved.                                                                  │
  │ policy         │                                                                                       │
  └────────────────┴───────────────────────────────────────────────────────────────────────────────────────┘

  This gate is a first-class feature. Social media agents, outreach agents, and any future agent that sends
  content to the outside world must pass through this gate. The gate fires for any tool call that would
  transmit content to an external recipient (social media API, email API, messaging API). Internal
  notifications (Telegram alerts to the owner) are exempt — this gate covers outbound communication to
  third parties only.

  Content pending approval is queued in SQLite and surfaced in the OpenPaw Web dashboard's content review
  section (see Section 8). The dashboard shows: full message content, recipient/platform, originating task,
  and approve/edit/reject controls. Editing allows the human to modify the content before approving.

  SQLite schema addition for communication gate:

  CREATE TABLE pending_communications (
      id TEXT PRIMARY KEY,
      gate_id TEXT REFERENCES hitl_gates(id),
      agent_id TEXT,
      platform TEXT NOT NULL,              -- twitter | email | linkedin | slack_external | ...
      recipient TEXT,                      -- email address, @handle, channel, etc.
      content_type TEXT NOT NULL,          -- text | html | media
      content TEXT NOT NULL,               -- the actual message/post content
      metadata TEXT,                       -- json: attachments, scheduling preferences, thread context
      created_at TIMESTAMP NOT NULL,
      decided_at TIMESTAMP,
      decision TEXT,                       -- approved | approved_edited | rejected
      edited_content TEXT                  -- non-null if human edited before approving
  );

  ---
  4. Failure Modes & Recovery

  F1: API Rate Limit / Quota Exhaustion

  ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
  │              │                                                                                         │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Detection    │ HTTP 429 or quota-exceeded error from provider API. NanoClaw's Agents SDK client        │
  │              │ surfaces this as a tool error.                                                          │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Automated    │ 1. Retry with exponential backoff: 30s, 60s, 120s (3 attempts max). 2. If still         │
  │ response     │ failing, switch to fallback model per agent roster (e.g., Sonnet → GPT-4.1). 3. If all  │
  │              │ providers for this agent type exhausted, terminate session as BLOCKED.                  │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Escalation   │ Notify human via Telegram after switching to fallback. Notify again if session          │
  │              │ terminates BLOCKED.                                                                     │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Data         │ Session's artifact updates (any written so far) persist in git. The plan shows the      │
  │ preserved    │ task's current status. SQLite logs the failure with error details.                      │
  └──────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

  F2: Agent Crash / Hang

  ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
  │              │                                                                                         │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │              │ NanoClaw monitors each headless session via the Agents SDK. If no tool call or text     │
  │ Detection    │ output for 10 minutes, session is considered hung. If the API connection drops, session │
  │              │  is considered crashed.                                                                 │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Automated    │ 1. Kill the session. 2. Mark task as FAILED in implementation_plan.md with: "Session    │
  │ response     │ hung/crashed. No output for 10 minutes." 3. If the session was running on Daytona, the  │
  │              │ Daytona environment persists for inspection.                                            │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Escalation   │ Notify human. Include: which task, which agent, how far it got (last tool call logged). │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Data         │ Daytona environment has any uncommitted code changes. Git has any commits made before   │
  │ preserved    │ the crash. SQLite has partial session record.                                           │
  └──────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

  F3: Bad Output Detected

  ┌─────────────┬──────────────────────────────────────────────────────────────────────────────────────────┐
  │             │                                                                                          │
  ├─────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Detection   │ Three sources: (1) Cubic flags issues on a PR. (2) Reviewer session finds problems. (3)  │
  │             │ Human rejects at HITL gate.                                                              │
  ├─────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │             │ 1. Mark task as FAILED in plan with specific findings (what's wrong, from which          │
  │ Automated   │ detector). 2. If this is the task's Nth failure, include all N failure records in the    │
  │ response    │ plan entry so the next session has full context. 3. Next Coder session for this task     │
  │             │ reads the failure notes and the contract's "what to do differently" guidance.            │
  ├─────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │             │ If same task fails 3 times: pause dispatch for that task, notify human with full failure │
  │ Escalation  │  history, wait for human intervention (rewrite contract, adjust acceptance criteria, or  │
  │             │ take over interactively).                                                                │
  ├─────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Data        │ All review findings in plan/contract. All code attempts in git history. Cubic review     │
  │ preserved   │ results accessible via Cubic dashboard.                                                  │
  └─────────────┴──────────────────────────────────────────────────────────────────────────────────────────┘

  F4: Budget Threshold Breach

  ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
  │              │                                                                                         │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Detection    │ NanoClaw aggregates cost_log entries against configured thresholds. Checked after every │
  │              │  API response that reports token usage.                                                 │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │              │ At 80% of daily limit: alert human, continue. At 100% of daily limit: pause all         │
  │ Automated    │ headless sessions. Running sessions are allowed to finish their current tool call but   │
  │ response     │ no new inference calls are dispatched. Interactive sessions (Claude Code) are           │
  │              │ unaffected — the human manages their own spend via Max plan.                            │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │              │ Immediate Telegram alert at 80%. Mandatory acknowledgment required to resume at 100%.   │
  │ Escalation   │ Human can: raise the daily limit, wait for tomorrow's reset, or switch remaining tasks  │
  │              │ to interactive mode.                                                                    │
  ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
  │ Data         │ Any in-progress session terminates as BLOCKED ("daily budget reached"). Plan and        │
  │ preserved    │ artifacts are updated per normal completion gate.                                       │
  └──────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

  F5: Orchestrator Restart (Mac Mini Reboots)

  Column 1: Detection
  Column 2: NanoClaw starts (via launchd LaunchAgent) and runs a recovery check: query SQLite for sessions with

    started_at IS NOT NULL AND ended_at IS NULL.
  ────────────────────────────────────────
  Column 1: Automated response
  Column 2: 1. For each orphaned session: mark it FAILED in SQLite with error "orchestrator restart, session
    orphaned." 2. Read implementation_plan.md. Any task marked "in-progress" with no matching COMPLETE session
    record is treated as FAILED. Update the plan: status → "ready" with note "prior session interrupted by
    restart." 3. Resume normal dispatch loop.
  ────────────────────────────────────────
  Column 1: Escalation
  Column 2: Log the restart event. If orphaned sessions are found, notify human via Telegram with list of
    affected tasks.
  ────────────────────────────────────────
  Column 1: Data preserved
  Column 2: Git repo is intact (filesystem survives reboot). SQLite is intact (file-based, write-ahead logging
    handles crash recovery). Daytona environments are unaffected (remote). The only loss is uncommitted
    in-memory state from the interrupted session, which is why the design mandates frequent artifact updates
    during execution.

  This is the key payoff of the session model: Orchestrator restart is a minor inconvenience, not a
  catastrophe. The artifacts carry all meaningful state. At worst, one task needs to be re-executed from
  scratch.

  ---
  5. Observability & Cost Tracking

  Tracing (Laminar)

  What gets traced: Every headless session. Laminar receives:
  - Session ID, agent type, task ID
  - Model and provider used
  - Each inference call: input tokens, output tokens, latency
  - Each tool call: tool name, arguments (sanitized — no secrets), result summary, latency
  - Terminal state

  What does NOT get traced: Interactive Claude Code sessions. These are human-supervised and logged by Claude
  Code itself. Duplicating traces would add complexity with no benefit.

  Integration: NanoClaw wraps each Agents SDK call with Laminar's tracing SDK. Since NanoClaw is Node/Bun, use
  Laminar's JavaScript SDK (@lmnr-ai/lmnr). Each session is a Laminar "trace" and each inference/tool call is a
   "span" within that trace.

  npm install @lmnr-ai/lmnr

  NanoClaw's agent dispatch function wraps session execution:

  import { Laminar, observe } from '@lmnr-ai/lmnr';
  Laminar.initialize({ projectApiKey: process.env.LAMINAR_API_KEY });

  const result = await observe({ name: `${agent}-${taskId}` }, async () => {
      return await runAgentSession(agent, task);
  });

  DEFERRED: Trace-based debugging UI. Laminar provides a dashboard. Use it as-is. Don't build a custom UI until
   Laminar's proves insufficient.

  Cost Tracking

  Approach: Provider dashboards + session-level SQLite logging.

  NanoClaw logs to cost_log after every API response that includes token usage. The cost calculation uses
  hardcoded per-model pricing:

  const PRICING = {
      'claude-sonnet-4-6':  { input: 3.0, output: 15.0 },   // per 1M tokens
      'claude-opus-4-6':    { input: 15.0, output: 75.0 },
      'gemini-2.5-pro':     { input: 1.25, output: 10.0 },
      'gpt-4.1':            { input: 2.0, output: 8.0 },
  };

  Reconcile monthly against provider dashboards (Anthropic Console, Google AI Studio, OpenAI Usage page). The
  SQLite log is the real-time view; provider dashboards are the audit trail.

  Queryable views:

  -- Daily spend by service
  SELECT date(logged_at) as day, service, SUM(amount_usd) as total
  FROM cost_log GROUP BY day, service;

  -- Spend per agent type this month
  SELECT s.agent, SUM(c.amount_usd) as total
  FROM cost_log c JOIN sessions s ON c.session_id = s.id
  WHERE c.logged_at >= date('now', 'start of month')
  GROUP BY s.agent;

  -- Most expensive sessions
  SELECT s.id, s.agent, s.task_id, SUM(c.amount_usd) as total
  FROM cost_log c JOIN sessions s ON c.session_id = s.id
  GROUP BY s.id ORDER BY total DESC LIMIT 10;

  DEFERRED: Real-time cost dashboard. Use SQLite queries and provider dashboards. A web dashboard is nice but
  not necessary until headless automation volume justifies it.

  Alerting

  NanoClaw sends alerts via its messaging integrations. All alerts go to a dedicated channel/chat to avoid
  mixing with HITL approval requests.

  ┌──────────────────────────┬─────────────────────────────────────────────────┬──────────┐
  │          Alert           │                     Trigger                     │ Channel  │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Session failed           │ Any session terminates FAILED                   │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Session blocked          │ Any session terminates BLOCKED                  │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Budget warning           │ Daily spend hits 80% of limit                   │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Budget hard stop         │ Daily spend hits 100% of limit                  │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Stuck task               │ Same task FAILED 3 times                        │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Orchestrator restart     │ NanoClaw starts and finds orphaned sessions     │ Telegram │
  ├──────────────────────────┼─────────────────────────────────────────────────┼──────────┤
  │ Fallback model activated │ Primary model unavailable, switched to fallback │ Telegram │
  └──────────────────────────┴─────────────────────────────────────────────────┴──────────┘

  Alert format:

  ⚠️ SESSION FAILED
  Task: 2.3 — Implement auth middleware
  Agent: Coder (claude-sonnet-4-6)
  Duration: 12m
  Error: Tests failing — 3/7 pass, auth_refresh_test timeout
  Cost: $1.24
  → Task marked FAILED in plan. Next session will retry.

  Decision Logging

  Every HITL gate decision is appended to data/decisions.jsonl (stored in NanoClaw's data directory, not the
  project git repo):

  {
      "id": "gate-2024-03-06-001",
      "gate_type": "deploy",
      "task_id": "3.1",
      "session_id": "sess-abc123",
      "requested_at": "2026-03-06T14:30:00Z",
      "decided_at": "2026-03-06T14:45:00Z",
      "decision": "approved",
      "context_hash": "sha256:a1b2c3...",
      "context_summary": "Deploy auth system to production. 7/7 tests pass. Cubic: no issues."
  }

  This file is append-only. Agents never read or modify it. It exists for audit purposes only.

  ---
  6. Implementation Sequence

  Phase 1: Structured Manual Workflow

  What: Establish the artifact model and execution lifecycle using Claude Code interactively. No automation. No
   NanoClaw. Human is the orchestrator.

  Build:
  1. Create project_spec.md template and implementation_plan.md template in the repo
  2. Write CLAUDE.md with the execution lifecycle rules (orient → select → execute → verify → update →
  terminate) and completion gate rules
  3. Create contracts/ and research/ directories
  4. Test the cycle manually: open Claude Code → it reads CLAUDE.md → reads plan → picks a task → executes →
  verifies → updates plan → terminates

  Validates: The artifact model works. The execution lifecycle rules are followed. The plan format is
  practical. The completion gate produces useful session log entries.

  Cost: $0 beyond existing Claude Code Max subscription.

  Exit criteria: You've completed 5+ tasks through the manual lifecycle and the plan accurately reflects
  project state without you manually fixing it.

  ---
  Phase 2: NanoClaw Core

  What: Set up NanoClaw on the Mac Mini. Configure it to read the plan and dispatch notifications. Not yet
  spawning headless sessions — just reading state and alerting you.

  Build:
  1. Deploy NanoClaw Docker container on Mac Mini
  2. Configure Telegram (or Slack) messaging integration
  3. Implement plan reader: NanoClaw watches implementation_plan.md (file watcher or 5-minute poll). When it
  detects a ready task, it sends a Telegram message: "Task 2.1 ready: Implement user login. Type: code."
  4. Set up SQLite database with the schema from Section 1
  5. Implement HITL gate infrastructure: NanoClaw can send approval requests and wait for responses via
  messaging
  6. Configure launchd LaunchAgent for auto-start on boot

  Validates: NanoClaw runs reliably as a daemon. Messaging integration works. Plan reading is correct. HITL
  gates work end-to-end.

  Cost: Minimal — NanoClaw's own resource usage plus Telegram API (free).

  Exit criteria: NanoClaw correctly identifies ready tasks from the plan and sends you notifications. You can
  approve/reject HITL gates via Telegram.

  ---
  Phase 3: Headless Coding

  What: NanoClaw spawns headless Coder sessions for well-specified tasks. This is where automation begins.

  Build:
  1. Create Coder agent system prompt (agents/coder/system_prompt.md) incorporating execution lifecycle rules
  2. Configure Anthropic Agents SDK integration in NanoClaw for Sonnet 4.6
  3. Integrate Daytona: NanoClaw creates/connects to a Daytona environment per session, mounts the project repo
  4. Implement tool definitions for Coder: file read/write (scoped), shell (sandboxed in Daytona), git
  operations
  5. Integrate Cubic: after Coder opens a PR, trigger Cubic review, capture results
  6. Implement fallback routing: Sonnet → GPT-4.1 on Anthropic API failure
  7. Implement session monitoring: heartbeat check, 10-minute hang detection
  8. Wire up deploy gate (Gate 2) for Vercel deployments
  9. Add cost logging to cost_log table

  Validates: Headless coding sessions complete tasks correctly. Daytona sandboxing works. Cubic reviews are
  captured. Fallback routing works. Costs are tracked.

  Cost: Anthropic API ($45-75/month for Coder sessions) + Daytona usage ($30-60/month) + Cubic ($30-50/month).

  Exit criteria: 10+ headless tasks completed successfully. At least one fallback-to-GPT event handled
  correctly. At least one deploy gate triggered and processed.

  ---
  Phase 4: Research Pipeline

  What: Add Researcher and Reviewer agents for W2.

  Build:
  1. Create Researcher agent system prompt with research-specific heuristics (start broad then narrow, source
  evaluation, citation requirements)
  2. Configure Gemini 2.5 Pro integration in NanoClaw
  3. Install BrowserUse CLI 2 on Mac Mini. Implement dual-mode BrowserUse tool wrapper (CLI subprocess +
  Cloud API). Make available as a configurable tool for any agent (Researcher, Coder, custom agents)
  4. Create research contract template with output format requirements (structured report, citations, source
  list)
  5. Create Reviewer agent system prompt with adversarial fact-checking instructions
  6. Wire up research brief gate (Gate 3)
  7. Integrate Dedalus Labs: deploy key MCP tools (web search, document parsing) to hosted environment

  Validates: Research briefs are produced with citations. Reviewer catches fabricated or unsupported claims.
  End-to-end flow from query to approved brief works.

  Cost: Gemini ($28-60/month) + BrowserUse ($50-80/month) + Dedalus ($20-40/month) + Anthropic API for Reviewer
   ($10/month).

  Exit criteria: 3+ research briefs completed end-to-end. Reviewer catches at least one issue that would have
  made it into the final brief. Human approves output quality.

  ---
  Phase 5: Observability & Alerting

  What: Add Laminar tracing, structured alerting, and budget controls.

  Build:
  1. Integrate Laminar JS SDK into NanoClaw's session dispatch
  2. Verify traces appear in Laminar dashboard for all headless sessions
  3. Implement alert routing (session failures, budget thresholds, stuck tasks)
  4. Implement budget hard-stop logic (pause headless dispatch at daily limit)
  5. Implement orchestrator restart recovery (orphaned session detection)
  6. Write the SQL views for cost reporting

  Validates: Every headless session produces a Laminar trace. Alerts fire correctly. Budget stops work. Restart
   recovery finds orphaned sessions.

  Cost: Laminar ($20-40/month).

  Exit criteria: Simulate each failure mode from Section 4 and verify the response. Budget hard-stop tested.
  Restart recovery tested (kill NanoClaw, restart, verify orphan handling).

  ---
  Phase 6: DEFERRED

  Items deferred until justified by operational experience:

  ┌─────────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
  │          Item           │                          Justification for deferral                          │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Automated key rotation  │ <12 keys, manual rotation is fine at this scale                              │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Cost-based model        │ Fixed model assignments work until budget pressure forces optimization       │
  │ routing                 │                                                                              │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Custom cost dashboard   │ SQLite queries + provider dashboards suffice                                 │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Multi-project           │ One project at a time for now; separate repos if needed                      │
  │ concurrent dispatch     │                                                                              │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Auto-approve rules      │ Default to manual for safety; automate gates only after trust is established │
  │                         │  through operational data                                                    │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Automated re-planning   │ Human reviews failures and decides re-plan scope; automation here risks      │
  │ on failure              │ runaway re-planning loops                                                    │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ 21st.dev deep           │ Coder can call 21st.dev API as a basic tool; deeper component library        │
  │ integration             │ integration deferred until W3 volume justifies it                            │
  ├─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ Async subagent          │ All dispatch is sequential (one headless session at a time); parallel        │
  │ coordination            │ dispatch deferred until sequential throughput is a proven bottleneck         │
  └─────────────────────────┴──────────────────────────────────────────────────────────────────────────────┘

---
7. Task Intake System

Command Taxonomy

OpenPaw accepts tasks via two intake channels: Telegram bot and the OpenPaw Web dashboard. Both use the same
explicit command structure — no LLM-based classification. Commands map directly to workflows:

/research <depth> <prompt>
  - Gate: Cost estimate echo → human approve/deny
  - Execution: Single Researcher session, no plan approval gate
  - Output: Research brief. Destination chosen after completion (GitHub, Notion, both, or custom)
  - Summary: Delivered in Telegram chat or webapp session panel
  - Depth: Requires depth parameter (1-10 scale, see Research Depth below)
  - Example: /research 5 "What are the key differences between Bun and Deno for backend services?"

/deep-research (/dr) <prompt>
  - Gate: Cost estimate echo → human approve → Planner creates research plan → plan approval gate (Gate 1)
  - Execution: Multi-session. Planner breaks research into sub-tasks, Researcher sessions execute each,
    Reviewer fact-checks the synthesized output
  - Output: Same as /research but typically longer, multi-section briefs
  - Summary: Delivered in Telegram chat or webapp session panel
  - Depth: Always operates at depth 8-10. The plan approval gate is the cost control mechanism
  - Example: /dr "Comprehensive comparison of all major LLM providers for agentic coding — capabilities,
    pricing, context windows, tool use quality. Include benchmarks where available."

/project <prompt>
  - Gate: NanoClaw auto-creates GitHub repo → Planner scaffolds repo (CLAUDE.md, project_spec.md,
    implementation_plan.md) → Planner session fleshes out the plan → plan approval gate (Gate 1, mandatory)
  - Execution: Full W1/W3 workflow. Tasks dispatched per implementation_plan.md
  - Output: GitHub repo with working code, progress briefs in repo under progress/
  - Summary: Session activity visible in webapp. Telegram notifications for HITL gates
  - Requires: GitHub repo creation permissions (pre-configured)
  - Example: /project "Web app that scrapes new job listings from LinkedIn, Indeed, and Glassdoor and
    auto-fills applications for the user"

/coding <project-name> <prompt>
  - Gate: Task added to existing project's implementation_plan.md → dispatched per normal task flow
  - Execution: Coder session within an existing project. Never free-floating — always tied to a project
  - Output: Code changes committed to project repo, PR opened
  - Example: /coding jobbot "Add rate limiting to the scraper API — max 10 requests per minute per site"

Scheduled agent tasks (no slash command — configured via agent definition files, managed in webapp)
  - Gate: Defined in agent config. Typically no per-run approval after initial setup
  - Execution: NanoClaw scheduler triggers agent per cron expression or event trigger
  - Output: Configurable per agent definition (Telegram, Notion, GitHub, webapp)
  - Example: Agent "tbpn-digest" runs daily at 20:00, reads newsletter, posts summary to Telegram

Research Depth Scale

The /research command requires a depth parameter (1-10) that controls scope, thoroughness, and cost:

Level 1-2: Quick lookup
  - Single-source answer, minimal synthesis
  - Typical cost: $0.05-$0.15
  - Example: "What's the context window for GPT-5.4?"

Level 3-4: Focused summary
  - 2-3 sources, brief comparison or synthesis
  - Typical cost: $0.15-$0.50
  - Example: "Compare pricing between Anthropic and OpenAI for agentic workloads"

Level 5-6: Standard research
  - Multiple sources, structured analysis, pros/cons
  - Typical cost: $0.50-$1.50
  - Example: "What are the key differences between Bun and Deno for backend services?"

Level 7-8: Thorough investigation
  - Broad source coverage, cross-referencing, detailed analysis with citations
  - Typical cost: $1.50-$4.00
  - Example: "Evaluate BrowserUse vs Playwright vs Puppeteer for AI-driven web scraping"

Level 9-10: Exhaustive deep dive
  - Comprehensive multi-source synthesis, benchmarks, primary source verification
  - Typical cost: $4.00-$12.00
  - Rarely used via /research — at this depth, /deep-research with plan approval is recommended

Cost estimation: Before execution, NanoClaw runs a lightweight reasoning call (Haiku-tier) that takes the
prompt + depth level and estimates token consumption based on: topic complexity, model used (Gemini for
research), expected source count at that depth level. The estimate is presented to the human:

  "Research: 'Bun vs Deno for backend' at depth 5. Model: Gemini 3.1 Pro. Estimated cost: $0.60-$0.90.
   Proceed? [Yes / No / Adjust depth]"

The cost function maps depth to approximate token budgets:
  depth 1-2: ~2K output tokens
  depth 3-4: ~5K output tokens
  depth 5-6: ~12K output tokens
  depth 7-8: ~25K output tokens
  depth 9-10: ~50K+ output tokens

These are guidelines, not hard caps. The Researcher session is aware of its depth target and scopes its
work accordingly. If a session approaches 2x its estimated cost, the spend threshold gate (Gate 5) fires.

---
8. OpenPaw Web — Dashboard & Control Plane

Architecture

Hybrid deployment:
- Frontend: Next.js (App Router) on Vercel
- Backend API: NanoClaw's built-in API module, running on Mac Mini
- Tunnel: Cloudflare Tunnel provides stable URL (openpaw.me) pointing to Mac Mini
- Real-time: WebSocket connections through the CF Tunnel for live session streaming
- Auth: Cloudflare Access (GitHub OAuth + MFA via Cloudflare's native second-factor support)
- UI Components: 21st.dev

Why monolithic NanoClaw (not a separate API service): Single user, <100 sessions/month. The arguments for
splitting (fault isolation, independent scaling) don't apply at this scale. NanoClaw is structured
internally as separate modules (orchestrator/, scheduler/, api/) but runs as one process. If splitting is
ever needed, the module boundaries make it a clean cut.

NanoClaw API Surface

NanoClaw exposes a REST + WebSocket API consumed by both the webapp and the Telegram bot.

REST endpoints:

Projects
  GET    /api/projects                    — list all projects
  POST   /api/projects                    — create project (triggers /project flow)
  GET    /api/projects/:id                — project detail (spec, plan, status)
  GET    /api/projects/:id/tasks          — list tasks for project

Tasks
  POST   /api/tasks                       — create task (research, coding, etc.)
  GET    /api/tasks/:id                   — task detail
  GET    /api/tasks/:id/sessions          — session history for task

Sessions
  GET    /api/sessions                    — list active and recent sessions
  GET    /api/sessions/:id               — session detail (status, cost, duration)

HITL Gates
  GET    /api/gates/pending               — list pending approval gates
  POST   /api/gates/:id/decide            — approve, reject, or edit a gate
  Body: { "decision": "approved" | "rejected", "edits": "..." }

Agents
  GET    /api/agents                      — list agent definitions
  GET    /api/agents/:id                  — agent detail + schedule
  POST   /api/agents/:id/trigger          — manually trigger a scheduled agent
  GET    /api/agents/:id/runs             — run history for agent
  GET    /api/agents/:id/health           — health check for service-type agents

Content Review (External Communications)
  GET    /api/communications/pending      — list pending outbound communications awaiting approval
  GET    /api/communications/:id          — full content + metadata for a pending communication
  POST   /api/communications/:id/decide   — approve, edit+approve, or reject
  Body: { "decision": "approved" | "approved_edited" | "rejected", "edited_content": "..." }

Cost
  GET    /api/cost/daily                  — daily spend breakdown
  GET    /api/cost/session/:id            — cost for specific session

WebSocket:

WS     /api/ws/sessions/:id/stream       — real-time stream of session activity
  Events: { type: "tool_call" | "text" | "status_change" | "cost_update", data: ... }

WS     /api/ws/notifications             — real-time alerts and gate requests
  Events: { type: "gate_pending" | "session_failed" | "budget_warning", data: ... }

Auth Flow

1. User navigates to openpaw.me
2. Cloudflare Access intercepts → GitHub OAuth login
3. Cloudflare Access enforces MFA (TOTP or hardware key via CF's native second-factor)
4. Authenticated requests pass through CF Tunnel to NanoClaw
5. NanoClaw validates the CF Access JWT on every request (cf-access-jwt-assertion header)
6. Single allowed user — NanoClaw config specifies the authorized GitHub username

No custom auth code in the webapp. Cloudflare Access handles identity, MFA, and session management.

UI Structure

Navigation: Vertical tab bar on the left edge (icon + label). Four top-level tabs:

┌──┐
│OV│  Overview
│RE│  Research
│PR│  Projects
│AU│  Automations
└──┘

The tab bar is always visible. Clicking a tab replaces the main content area. A command input bar
("Ask anything or give a task") sits in the top header, available from any tab.

Theme: Dark background, amber/gold accent color. 21st.dev components throughout.

--- Overview Tab ---

Summary cards + recent activity. This is the landing page.

┌────────────────────────────────────────────────────────────────────────────────────────────┐
│  OpenPaw          Monday, 6 March 2026 · 15:03     [Ask anything or give a task...] [Send]│
├──┬─────────────────────────────────────────────────────────────────────────────────────────┤
│  │                                                                                         │
│OV│  DAILY SPEND                                      BUDGET                                │
│  │  $4.20                                            $50/day                               │
│RE│  ████████░░░░░░░░░░░░░░ 8.4% of daily budget                                           │
│  │                                                                                         │
│PR│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                    │
│  │  │ 3            │ │ 2            │ │ 4            │ │ 1            │                    │
│AU│  │ Active       │ │ Pending      │ │ Research     │ │ Automations  │                    │
│  │  │ Sessions     │ │ Gates        │ │ Tasks        │ │ Running      │                    │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘                    │
│  │                                                                                         │
│  │  RECENT ACTIVITY                                                                        │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │  │ 14:52  Coder session completed — Task 2.3 auth middleware  [JobBot]   $0.82     │   │
│  │  │ 14:30  HITL Gate pending — Deploy to staging               [JobBot]   Action →  │   │
│  │  │ 13:15  Research complete — GPT 5.4 evaluation                         $1.24     │   │
│  │  │ 12:00  TBPN Digest delivered                               [Agent]    $0.38     │   │
│  │  │ 11:45  Coder session started — Task 2.4 user profiles     [JobBot]              │   │
│  │  └──────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
└──┴─────────────────────────────────────────────────────────────────────────────────────────┘

Overview shows: daily spend vs budget, summary cards (active sessions, pending gates, research tasks,
running automations), and a chronological activity feed. Pending gates in the activity feed are
actionable — click to approve/deny inline.

--- Research Tab ---

List of all research tasks (active + completed). Click a task to see full results.

┌──┬─────────────────────────────────────────────────────────────────────────────────────────┐
│  │  Research                                                        [+ New Research]       │
│OV│                                                                                         │
│  │  ACTIVE                                                                                 │
│RE│  ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │  │ Bun vs Deno for backend   Depth 5   Gemini 3.1 Pro   $0.34   6m   ● Running    │   │
│PR│  └──────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
│AU│  COMPLETED                                                                              │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │  │ GPT 5.4 evaluation        Depth 6   Gemini 3.1 Pro   $1.24   18m  ✓ Complete   │   │
│  │  │ Summary: 12% improvement on SWE-bench over 5.3, but 40% more expensive...       │   │
│  │  │ [Save to GitHub] [Save to Notion] [Both]                                        │   │
│  │  ├─────────────────────────────────────────────────────────────────────────────────┤   │
│  │  │ React vs Svelte 2026      Depth 4   Gemini 3.1 Pro   $0.42   8m   ✓ Complete   │   │
│  │  └──────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
└──┴─────────────────────────────────────────────────────────────────────────────────────────┘

Clicking an active research task opens a detail view with real-time session streaming.
Completed tasks show summary inline with output routing buttons.

--- Projects Tab ---

List of all projects. Click a project to enter the project workspace.

┌──┬─────────────────────────────────────────────────────────────────────────────────────────┐
│  │  Projects                                                        [+ New Project]        │
│OV│                                                                                         │
│  │  ┌─ JobBot ────────────────────────────────────────────────────────────────────────┐   │
│RE│  │ Web app that scrapes job listings and auto-fills applications                    │   │
│  │  │ 4/12 tasks complete · 2 active sessions · $8.40 total spend                     │   │
│PR│  │ ████████████░░░░░░░░░░░░░░░░░░ 33%                                  [Open →]   │   │
│  │  └─────────────────────────────────────────────────────────────────────────────────┘   │
│AU│  ┌─ PersonalSite ──────────────────────────────────────────────────────────────────┐   │
│  │  │ Portfolio website with blog                                                      │   │
│  │  │ 8/8 tasks complete · 0 active sessions · $12.10 total spend                     │   │
│  │  │ ████████████████████████████████████████ 100%                        [Open →]   │   │
│  │  └─────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
└──┴─────────────────────────────────────────────────────────────────────────────────────────┘

--- Project Workspace (inside a project) ---

When you click into a project, the layout changes. A secondary sidebar appears with the project's
task list. The main area shows tmux-like tiled session panels.

┌──┬──────────────┬──────────────────────────────────────────────────────────────────────────┐
│  │ JobBot       │                                                                          │
│OV│              │  ┌─ Backend API ──────────────────┐  ┌─ Frontend Research ──────────┐   │
│  │ TASKS        │  │ [Coder, Sonnet 4.6]            │  │ [Researcher, Gemini]         │   │
│RE│ ✓ 1.1 Setup  │  │                                │  │                              │   │
│  │ ✓ 1.2 Schema │  │ Reading auth middleware...      │  │ Browsing React frameworks... │   │
│PR│ ● 2.3 Auth   │  │ Writing tests for /api/users    │  │ Found 4 benchmark comps      │   │
│  │ ● 2.4 Profiles  │ 4/7 tests passing               │  │ Synthesizing findings...     │   │
│AU│ ○ 3.1 Scraper│  │                                │  │                              │   │
│  │ ○ 3.2 Apply  │  │ Cost: $0.82 | 12m              │  │ Cost: $0.34 | 6m             │   │
│  │ ○ 4.1 Deploy │  │                                │  │                              │   │
│  │              │  │ ┌─ HITL Gate ───────────────┐  │  │                              │   │
│  │ ● active     │  │ │ Deploy to staging?        │  │  │                              │   │
│  │ ✓ complete   │  │ │ [Approve] [Edit] [Deny]  │  │  │                              │   │
│  │ ○ pending    │  │ └──────────────────────────┘  │  │                              │   │
│  │              │  └────────────────────────────────┘  └──────────────────────────────┘   │
│  │              │                                                                          │
└──┴──────────────┴──────────────────────────────────────────────────────────────────────────┘

The secondary sidebar (task list) is project-specific. Clicking a task opens its session panel
in the main area. Multiple panels can be tiled side by side. Panels are resizable and closable.

--- Automations Tab ---

List of all agent definitions with status, schedule, and controls.

┌──┬─────────────────────────────────────────────────────────────────────────────────────────┐
│  │  Automations                                                                            │
│OV│                                                                                         │
│  │  ┌─ TBPN Digest ───────────────────────────────────────────────────────────────────┐   │
│RE│  │ Daily newsletter digest · Gemini 3.1 Pro                                         │   │
│  │  │ Schedule: Every day at 8:00 PM    Next run: Today 20:00                          │   │
│PR│  │ Last run: Yesterday 20:00 · $0.38 · ✓ Complete                                  │   │
│  │  │ [Run Now] [Disable] [View History]                                  ● Enabled    │   │
│AU│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│  │  ┌─ Twitter Poster ────────────────────────────────────────────────────────────────┐   │
│  │  │ Auto-posts project updates to Twitter · Sonnet 4.6                               │   │
│  │  │ Schedule: on_commit: main           Trigger: event-based                         │   │
│  │  │ Last run: 2 hours ago · $0.12 · ✓ Complete                                      │   │
│  │  │ [Run Now] [Disable] [View History]                                  ● Enabled    │   │
│  │  └─────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
└──┴─────────────────────────────────────────────────────────────────────────────────────────┘

--- Content Review Tab ---

Queue of outbound communications awaiting approval. Any agent that triggers Gate 6 (External Communication)
places its content here. This is the primary review interface for social media posts, outreach emails, and
any other external-facing content.

┌──┬─────────────────────────────────────────────────────────────────────────────────────────┐
│  │  Content Review                                                          3 pending      │
│OV│                                                                                         │
│  │  ┌─ Twitter Post ────────────────────────────────────────────────────────────────────┐  │
│RE│  │ Agent: Twitter Poster · Triggered by: commit abc123 to main                       │  │
│  │  │                                                                                    │  │
│PR│  │ "Just shipped real-time session streaming in OpenPaw 🚀                           │  │
│  │  │  Now you can watch your AI agents work live from the dashboard.                    │  │
│AU│  │  #buildinpublic #AIagents"                                                        │  │
│  │  │                                                                                    │  │
│CR│  │ [✓ Approve]  [✎ Edit & Approve]  [✗ Reject]                    2 min ago           │  │
│  │  └───────────────────────────────────────────────────────────────────────────────────┘  │
│  │  ┌─ Outreach Email ──────────────────────────────────────────────────────────────────┐  │
│  │  │ Agent: Cold Outreach · To: jane@example.com                                       │  │
│  │  │                                                                                    │  │
│  │  │ Subject: Quick question about your API integration...                              │  │
│  │  │ "Hi Jane, I noticed your company recently launched..."                             │  │
│  │  │                                                                                    │  │
│  │  │ [✓ Approve]  [✎ Edit & Approve]  [✗ Reject]                    15 min ago          │  │
│  │  └───────────────────────────────────────────────────────────────────────────────────┘  │
│  │                                                                                         │
│  │  RECENTLY DECIDED                                                                       │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │  │ LinkedIn Post · Approved (edited) · 1 hour ago                                   │   │
│  │  │ Twitter Post  · Approved · 3 hours ago                                           │   │
│  │  │ Outreach Email · Rejected · Yesterday                                            │   │
│  │  └──────────────────────────────────────────────────────────────────────────────────┘   │
│  │                                                                                         │
└──┴─────────────────────────────────────────────────────────────────────────────────────────┘

Edit & Approve opens an inline editor pre-filled with the agent's draft. The human can modify the
content before approving. The edited version is what gets sent. Original and edited versions are both
stored for audit.

Navigation summary:
- Left tab bar (always visible): Overview | Research | Projects | Content Review | Automations
- Top header (always visible): Command input bar, daily spend, pending content badge
- Secondary sidebar (Projects only): Appears inside a project workspace, shows task list
- Panels: Tiled session views inside Project workspace and Research detail views

New Task flow:
1. Use the command input bar in the header, OR click "+ New Research" / "+ New Project" on
   their respective tabs
2. Pick type (if using command bar): Research / Deep Research / Project / Coding
3. Type prompt. For research, select depth (1-10 slider)
4. See cost estimate
5. Approve → navigates to the relevant tab with the new task visible

The webapp is read-only with respect to code. No embedded terminal, no Claude Code in the browser.
For interactive coding, the user opens Claude Code locally on the Mac Mini or their laptop and works
in the project repo directly.

---
9. Agent Fleet & Scheduling

Agent Definition Format

Custom agents are defined as markdown files in the repo at agents/<agent-name>/agent.md. The human designs
all agent definitions using Claude Code. NanoClaw reads these files to know what agents exist and how to
run them.

Example: agents/tbpn-digest/agent.md

```
# TBPN Newsletter Digest

## Identity
agent_type: custom
model: gemini-3.1-pro
provider: google

## Description
Reads the daily TBPN newsletter and produces a concise digest highlighting the most relevant items
for an AI/ML engineer focused on agentic systems and developer tools.

## Schedule
cron: "0 20 * * *"  # Every day at 8:00 PM

## Tools
- browseruse:
    mode: cloud
    headless: true
- web_search: true
- file_write: true

## Input
Navigate to [TBPN newsletter URL] and read today's edition. If no new edition today, report "No new
edition" and terminate.

## Output
- telegram: summary
- notion: full_report
- github: full_report (path: research/tbpn/)

## Depth
level: 4

## Budget
max_cost_per_run: $1.00
```

Agent definition fields:
- Identity: agent type, model, provider
- Description: what the agent does (also serves as context for the system prompt)
- Schedule: cron expression for time-based triggers, or event triggers
- Tools: which tools the agent has access to
- Input: instructions for the agent (can reference URLs, files, or other data sources)
- Output: where results go, using the routing config syntax
- Depth: research depth level (for research-type agents)
- Budget: per-run cost cap

Output Routing Config

Each agent or task can specify output destinations:

```
## Output
- telegram: summary           # Send a short summary to Telegram
- notion: full_report          # Write the full report to a Notion page
- github: full_report (path: research/digests/)  # Commit full report to repo
```

Supported destinations:
- telegram: Sends formatted message to the OpenPaw Telegram chat
- github: Commits output file to the project repo at the specified path
- notion: Creates/updates a Notion page (DEFERRED — GitHub-only at launch, Notion added later)
- webapp: Output visible in the session panel (always on, not configurable)

Output types:
- summary: Condensed version suitable for chat/notification (generated by the agent)
- full_report: Complete output document

Scheduling System

NanoClaw includes a scheduler module that supports two trigger types:

1. Cron-based (time triggers)
  - Standard cron expressions: "0 20 * * *" (daily at 8pm), "0 9 * * 1" (Mondays at 9am)
  - Evaluated by NanoClaw's scheduler loop (checks every minute)
  - When a cron fires: NanoClaw creates a session for the agent, executes it, routes output

2. Event-based (repo/system triggers)
  - on_commit: <branch> — triggers when a commit lands on the specified branch
  - on_task_complete: <task_pattern> — triggers when a matching task completes
  - on_gate_approved: <gate_type> — triggers after a specific gate type is approved
  - Evaluated by NanoClaw's event listener (watches git repo via fswatch, listens for internal events)

Schedule config lives in the agent definition file (agents/<name>/agent.md). NanoClaw reads all agent
definitions on startup and when files change (fswatch on agents/ directory).

SQLite schema addition for scheduled agents:

CREATE TABLE agent_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config_path TEXT NOT NULL,         -- path to agent.md
    schedule_type TEXT,                -- cron | event | manual
    schedule_expression TEXT,          -- cron expression or event spec
    enabled BOOLEAN DEFAULT true,
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agent_definitions(id),
    session_id TEXT REFERENCES sessions(id),
    triggered_by TEXT NOT NULL,        -- schedule | manual | event
    trigger_detail TEXT,               -- which cron tick or event
    started_at TIMESTAMP NOT NULL,
    ended_at TIMESTAMP,
    status TEXT,                       -- running | complete | failed
    output_routed_to TEXT             -- json array of destinations used
);

Agent Management via Webapp

The webapp's Agents sidebar section shows:
- All defined agents with enabled/disabled toggle
- Last run time and status
- Next scheduled run time
- Manual trigger button ("Run now")
- Link to run history

Agent definitions are created and edited via Claude Code (markdown files in the repo). The webapp does
not provide an agent editor — it's a viewer and controller, not an authoring tool.

---
10. Telegram Bot

The Telegram bot serves three functions:

1. Task intake: Accept /research, /dr, /project, /coding commands
2. HITL gate responses: Present approval requests, accept approve/deny replies
3. Alerts: Receive session failures, budget warnings, scheduled agent outputs

Command handling:

/research <depth> <prompt>
  → NanoClaw creates research task
  → Bot echoes cost estimate
  → Human replies "yes" or "no"
  → On "yes": session dispatched, bot sends summary when complete

/dr <prompt>
  → NanoClaw creates deep research task
  → Planner session generates research plan
  → Bot sends plan summary for approval
  → Human replies "approve" / "deny" / edits
  → On approve: research sessions dispatched

/project <prompt>
  → NanoClaw creates GitHub repo, scaffolds, runs Planner
  → Bot sends plan for approval
  → Standard W1/W3 flow from there

/coding <project> <prompt>
  → NanoClaw adds task to project's plan
  → Dispatched per normal task flow

/status
  → Current active sessions, pending gates, daily spend

/agents
  → List scheduled agents with status and next run time

HITL gate delivery:
  Bot sends formatted gate request. Human replies inline:
  - "approve" or "yes" → gate approved
  - "deny" or "no" → gate rejected
  - Any other text → treated as edit/feedback, attached to gate context

Alert delivery:
  Alerts use a separate Telegram chat/channel from HITL gates to avoid mixing operational noise
  with action-required messages.

---
11. Updated Implementation Sequence

The original phases (1-5) remain valid. The following phases extend the sequence:

Phase 6: Task Intake & Telegram Bot

What: Add the command system and Telegram bot as a task intake channel.

Build:
1. Implement command parser for /research, /dr, /project, /coding
2. Build Telegram bot with command handling (node-telegram-bot-api or grammy)
3. Implement cost estimation: lightweight Haiku call that takes prompt + depth + model → estimated cost
4. Wire cost estimate echo → approval flow in Telegram
5. Implement /research direct execution path (bypass plan approval gate)
6. Implement /project GitHub repo creation (GitHub API: create repo, clone, scaffold, push)
7. Add /status and /agents informational commands

Validates: Tasks can be created from Telegram. Cost estimates are reasonable. Research tasks execute
without plan gates. Projects create repos and scaffold correctly.

Exit criteria: 5+ research tasks created and completed via Telegram. 1+ project created via Telegram
with repo scaffolding. Cost estimates within 2x of actual costs.

---
Phase 7: OpenPaw Web — Dashboard

What: Build the webapp frontend and NanoClaw API layer.

Build:
1. Implement NanoClaw API module (REST endpoints listed in Section 8)
2. Set up Cloudflare Tunnel pointing to Mac Mini
3. Configure Cloudflare Access with GitHub OAuth + MFA
4. Create Next.js app with 21st.dev components
5. Build sidebar: projects list, research list, agents list
6. Build session panel component with real-time WebSocket streaming
7. Build tmux-like panel layout (resizable, rearrangeable tiled panels)
8. Build "New Task" flow: type picker → prompt → depth slider → cost estimate → approve
9. Build HITL gate inline UI (approve/edit/deny buttons in session panels)
10. Build cost display (daily spend in header, per-session cost in panels)
11. Build Content Review tab: pending communications queue, approve/edit/reject controls, history
12. Deploy frontend to Vercel

Validates: Full dashboard with real-time session visibility. Tasks can be created from webapp. HITL
gates can be resolved from webapp. Content review queue shows pending communications. Auth works
end-to-end.

Exit criteria: All functionality available via Telegram is also available via webapp. Real-time
streaming shows live session activity. Content review approve/edit/reject flow works. Auth blocks
unauthorized access.

---
Phase 8: Agent Fleet & Scheduling

What: Add scheduling infrastructure, custom agent support, and the ServiceAdapter for external agents.

Build:
1. Implement AgentAdapter interface and LLMAdapter (refactor existing session management to use it)
2. Implement ServiceAdapter (HTTP trigger, status polling, webhook support, health checks)
3. Implement scheduler module in NanoClaw (cron evaluation loop, event listener)
4. Implement agent definition parser (reads agents/<name>/agent.md files, including adapter config)
5. Add agent_definitions and agent_runs tables to SQLite
6. Implement fswatch on agents/ directory for hot-reload of agent definitions
7. Implement output routing engine (telegram, github destinations)
8. Build webapp Agents section (list, status, manual trigger, run history, health status for service agents)
9. Add /agents command to Telegram bot
10. Create 2-3 initial agent definitions as templates (e.g., newsletter digest, calendar agent integration)

Validates: Scheduled agents run at correct times. Event triggers fire correctly. Output routes to
configured destinations. Agents can be enabled/disabled from webapp. At least one external service
agent connects and responds correctly via ServiceAdapter.

Exit criteria: 1+ cron-scheduled agent running reliably for 1 week. 1+ event-triggered agent fires
correctly. 1+ external service agent (e.g., calendar) triggered and responding via ServiceAdapter.
Output routing delivers to all configured destinations.

---
Phase 9: Notion Integration (DEFERRED)

What: Add Notion as an output destination for research briefs and agent outputs.

Build:
1. Notion API integration (create pages, write formatted content)
2. Add "notion" destination to output routing engine
3. Configure Notion workspace and database structure
4. Add Notion page links to webapp session panels and Telegram summaries

Deferred until: Core loop (Phases 1-8) is stable and operational. Notion adds convenience but
GitHub markdown output is functional for all use cases in the interim.

---
12. Updated Component Diagram

graph TB
    subgraph MacMini["Mac Mini — Gateway + Orchestrator"]
        NC["NanoClaw daemon<br/>(Node/Bun, Docker)<br/>orchestrator + scheduler + API"]
        DB["SQLite<br/>sessions.db + agents"]
        Git["Git repo<br/>Persistent artifacts + agent definitions"]
        CC["Claude Code CLI<br/>(interactive sessions)"]
    end

    subgraph Web["OpenPaw Web"]
        FE["Next.js frontend<br/>(Vercel)"]
        CF["Cloudflare Tunnel<br/>+ Access (auth)"]
    end

    subgraph Providers["LLM Providers"]
        Anth["Anthropic API"]
        OAI["OpenAI API"]
        Gem["Gemini API"]
    end

    subgraph DevInfra["Dev Infrastructure"]
        Day["Daytona"]
        Ver["Vercel (deploy)"]
        Cub["Cubic"]
        T21["21st.dev"]
        GH["GitHub API<br/>repo creation"]
    end

    subgraph BrowserAuto2["Browser Automation"]
        BU["BrowserUse CLI 2<br/>direct CDP, dual-mode"]
    end

    subgraph Research["Research Infrastructure"]
        Ded["Dedalus Labs MCP"]
    end

    subgraph Obs["Observability"]
        Lam["Laminar"]
    end

    subgraph Msg["Human Interface"]
        TG["Telegram Bot"]
        FE
    end

    FE <--> CF
    CF <--> NC
    NC <--> DB
    NC <--> Git
    CC <--> Git
    NC --> Anth
    NC --> OAI
    NC --> Gem
    CC --> Anth
    NC --> Day
    NC --> Ver
    NC --> Cub
    NC --> T21
    NC --> GH
    NC --> BU
    NC --> Ded
    NC --> Lam
    NC <--> TG

Key changes from original diagram:
- NanoClaw now includes scheduler and API modules
- OpenPaw Web (Vercel + CF Tunnel) added as a human interface
- GitHub API added for repo creation
- Telegram and webapp are both intake channels, not just notification targets