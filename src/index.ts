import { loadSecrets } from "./secrets.ts";
import {
  createBot,
  startBot,
  sendMessage,
  onMessage,
} from "./messaging/index.ts";
import { initDatabase } from "./db/index.ts";
import { initGates, resolveGateById } from "./gates/index.ts";
import { watchPlan } from "./plan/reader.ts";
import { SessionRunner } from "./agents/runner.ts";
import { ResearchRunner } from "./research/runner.ts";
import { recoverOrphanedSessions } from "./agents/recovery.ts";
import { AlertSystem } from "./alerts/index.ts";
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG } from "./budget/index.ts";
import { initTracing, shutdownTracing } from "./tracing/index.ts";
import { createRouter, validateCfAccess, NanoClawEvents, parseWsPath } from "./api/index.ts";
import { FleetOrchestrator } from "./fleet/index.ts";
import type { ApiDeps, AuthDeps } from "./api/index.ts";
import { allRoutes } from "./api/routes/index.ts";

const HEALTH_PORT = 9999;
const REPO_DIR = "/repo";
const DB_PATH = "/data/nanoclaw.db";
const PLAN_PATH = `${REPO_DIR}/implementation_plan.md`;
const SYSTEM_PROMPT_PATH = `${REPO_DIR}/agents/coder/system_prompt.md`;
const RESEARCHER_PROMPT_PATH = `${REPO_DIR}/agents/researcher/system_prompt.md`;
const RESEARCHER_REVIEWER_PROMPT_PATH = `${REPO_DIR}/agents/researcher-reviewer/system_prompt.md`;
const DEFAULT_BRANCH = "main";
const WORKSPACES_DIR = "/workspaces";

const secrets = loadSecrets();

// --- Database ---
const db = initDatabase(DB_PATH);
console.log(`[nanoclaw] database initialized: ${DB_PATH}`);

// --- Telegram bot ---
const telegramToken = secrets.get("telegram_bot_token");
const telegramChatId = secrets.get("telegram_chat_id");

let sendAlert: (message: string) => Promise<void>;

if (telegramToken && telegramChatId) {
  createBot(telegramToken, telegramChatId);
  startBot();

  sendAlert = async (msg: string) => {
    await sendMessage(telegramChatId, msg);
  };

  // --- HITL Gates ---
  initGates({
    db,
    chatId: parseInt(telegramChatId, 10),
    send: sendMessage,
    onMessage,
  });
  console.log("[nanoclaw] HITL gates initialized");
} else {
  console.warn("[nanoclaw] telegram secrets missing — bot disabled");
  sendAlert = async (msg: string) => {
    console.log(`[nanoclaw] alert (no telegram): ${msg}`);
  };
}

// --- Alert System ---
const alertsChatId = secrets.get("alerts_chat_id");
const alertSystem = new AlertSystem({
  sendMessage,
  alertsChatId: alertsChatId ?? undefined,
  fallbackChatId: telegramChatId ?? "",
});
if (alertsChatId) {
  console.log("[nanoclaw] alerts routed to dedicated channel");
} else {
  console.log("[nanoclaw] alerts routed to main chat (no alerts_chat_id)");
}

// --- Tracing ---
const laminarApiKey = secrets.get("laminar_api_key");
const secretValues = new Set(secrets.values());
initTracing({ laminarApiKey, secretValues });

// --- Budget Enforcer ---
const budgetEnforcer = new BudgetEnforcer({
  db,
  alertSystem,
  config: DEFAULT_BUDGET_CONFIG,
});
console.log(`[nanoclaw] budget enforcer: $${DEFAULT_BUDGET_CONFIG.dailyLimitUsd}/day, ${DEFAULT_BUDGET_CONFIG.warningThresholdPct * 100}% warning`);

// --- Session Runner ---
const anthropicApiKey = secrets.get("anthropic_api_key");
const openaiApiKey = secrets.get("openai_api_key") ?? "";
if (!openaiApiKey) {
  console.warn("[nanoclaw] openai_api_key missing — Codex adapter will fail, Claude fallback only");
}

// --- Restart Recovery (before plan watcher) ---
const recovered = await recoverOrphanedSessions({
  db,
  planPath: PLAN_PATH,
  sendAlert,
});
if (recovered > 0) {
  console.log(`[nanoclaw] recovered ${recovered} orphaned session(s)`);
}

// --- Research Runner ---
const geminiApiKey = secrets.get("gemini_api_key");
const browserUseApiKey = secrets.get("browseruse_cloud_api_key");

let researchRunner: ResearchRunner | null = null;

if (geminiApiKey) {
  researchRunner = new ResearchRunner({
    db,
    sendAlert,
    geminiApiKey,
    anthropicApiKey: anthropicApiKey ?? "",
    browserUseDeps: { cloudApiKey: browserUseApiKey ?? "" },
    planPath: PLAN_PATH,
    systemPromptPath: RESEARCHER_PROMPT_PATH,
    reviewerPromptPath: RESEARCHER_REVIEWER_PROMPT_PATH,
    budgetEnforcer,
  });
  console.log("[nanoclaw] research runner initialized");
} else {
  console.warn("[nanoclaw] gemini_api_key missing — research pipeline disabled");
}

// --- Fleet Orchestrator ---
const AGENTS_DIR = `${REPO_DIR}/agents`;

const fleetSendMessage = async (chatId: string, text: string) => {
  await sendMessage(chatId, text);
};

const fleetOrchestrator = new FleetOrchestrator({
  db,
  secrets,
  sendMessage: fleetSendMessage,
  chatId: telegramChatId ?? "",
  repoDir: REPO_DIR,
  agentsDir: AGENTS_DIR,
  budgetEnforcer,
});
fleetOrchestrator.start();

if (anthropicApiKey) {
  const runner = new SessionRunner({
    db,
    sendAlert,
    anthropicApiKey,
    openaiApiKey,
    repoMount: REPO_DIR,
    branch: DEFAULT_BRANCH,
    planPath: PLAN_PATH,
    systemPromptPath: SYSTEM_PROMPT_PATH,
    sandboxDeps: { baseDir: WORKSPACES_DIR },
    budgetEnforcer,
    alertSystem,
  });

  // --- Plan Watcher ---
  const watcher = watchPlan(PLAN_PATH, (readyTasks) => {
    for (const task of readyTasks) {
      console.log(
        `[nanoclaw] ready task detected: ${task.id} — ${task.title}`,
      );
      runner.enqueue(task).catch((err) => {
        console.error(`[nanoclaw] enqueue error for task ${task.id}: ${err}`);
      });
    }
  });

  console.log(
    "[nanoclaw] session runner started, watching plan for ready tasks",
  );

  // Clean shutdown
  process.on("SIGTERM", async () => {
    console.log("[nanoclaw] SIGTERM received, shutting down...");
    watcher.stop();
    runner.stop();
    researchRunner?.stop();
    fleetOrchestrator.stop();
    await shutdownTracing();
  });
} else {
  console.warn(
    "[nanoclaw] missing anthropic API key — headless sessions disabled",
  );

  // Still handle SIGTERM for research runner, fleet, and tracing
  process.on("SIGTERM", async () => {
    console.log("[nanoclaw] SIGTERM received, shutting down...");
    researchRunner?.stop();
    fleetOrchestrator.stop();
    await shutdownTracing();
  });
}

// --- API Server ---
const events = new NanoClawEvents();

const apiDeps: ApiDeps = {
  db,
  resolveGateFn: resolveGateById,
  planPath: PLAN_PATH,
  events,
};

const cfTeamDomain = secrets.get("cf_team_domain") ?? "";
const cfAudienceTag = secrets.get("cf_audience_tag") ?? "";
const authDeps: AuthDeps = {
  teamDomain: cfTeamDomain,
  audienceTag: cfAudienceTag,
};

const router = createRouter(allRoutes(), apiDeps);

interface WsChannelData {
  channel: string;
  sessionId?: string;
}

const server = Bun.serve<WsChannelData>({
  port: HEALTH_PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check (unauthenticated)
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      // Validate auth for WS connections
      if (cfTeamDomain) {
        const valid = await validateCfAccess(req, authDeps);
        if (!valid) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const wsInfo = parseWsPath(url.pathname);
      if (!wsInfo) {
        return new Response("Not found", { status: 404 });
      }
      const upgraded = server.upgrade(req, { data: wsInfo });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Auth check for API routes
    if (url.pathname.startsWith("/api/") && cfTeamDomain) {
      const valid = await validateCfAccess(req, authDeps);
      if (!valid) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return router(req);
  },
  websocket: {
    open(ws) {
      events.subscribe(ws.data.channel, ws);
    },
    close(ws) {
      events.unsubscribe(ws.data.channel, ws);
    },
    message(_ws, _msg) {
      // Handle pong responses (no action needed)
    },
  },
});

console.log(
  `[nanoclaw] NanoClaw API running on http://localhost:${server.port}`,
);
if (cfTeamDomain) {
  console.log(`[nanoclaw] CF Access auth enabled (team: ${cfTeamDomain})`);
} else {
  console.log("[nanoclaw] CF Access auth disabled (dev mode)");
}
console.log(`[nanoclaw] secrets: ${secrets.size}, pid: ${process.pid}`);
