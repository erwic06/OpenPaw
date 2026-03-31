import { loadSecrets } from "./secrets.ts";
import {
  createBot,
  startBot,
  sendMessage,
  onMessage,
} from "./messaging/index.ts";
import { initDatabase } from "./db/index.ts";
import { initGates } from "./gates/index.ts";
import { watchPlan } from "./plan/reader.ts";
import { SessionRunner } from "./agents/runner.ts";

const HEALTH_PORT = 9999;
const REPO_DIR = "/repo";
const DB_PATH = "/data/nanoclaw.db";
const PLAN_PATH = `${REPO_DIR}/implementation_plan.md`;
const SYSTEM_PROMPT_PATH = `${REPO_DIR}/agents/coder/system_prompt.md`;
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

// --- Session Runner ---
const anthropicApiKey = secrets.get("anthropic_api_key");
const openaiApiKey = secrets.get("openai_api_key") ?? "";

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
  process.on("SIGTERM", () => {
    console.log("[nanoclaw] SIGTERM received, shutting down...");
    watcher.stop();
    runner.stop();
  });
} else {
  console.warn(
    "[nanoclaw] missing anthropic API key — headless sessions disabled",
  );
}

// --- Health endpoint ---
const server = Bun.serve({
  port: HEALTH_PORT,
  fetch() {
    return new Response("ok", { status: 200 });
  },
});

console.log(
  `[nanoclaw] NanoClaw daemon running (health: http://localhost:${server.port})`,
);
console.log(`[nanoclaw] secrets: ${secrets.size}, pid: ${process.pid}`);
