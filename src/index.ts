import { loadSecrets } from "./secrets.ts";
import { createBot, startBot } from "./messaging/index.ts";

const HEALTH_PORT = 9999;

const secrets = loadSecrets();

// --- Telegram bot ---
const telegramToken = secrets.get("telegram_bot_token");
const telegramChatId = secrets.get("telegram_chat_id");

if (telegramToken && telegramChatId) {
  createBot(telegramToken, telegramChatId);
  startBot();
} else {
  console.warn("[nanoclaw] telegram secrets missing — bot disabled");
}

// --- Health endpoint ---
const server = Bun.serve({
  port: HEALTH_PORT,
  fetch() {
    return new Response("ok", { status: 200 });
  },
});

console.log(`[nanoclaw] NanoClaw daemon running (health: http://localhost:${server.port})`);
console.log(`[nanoclaw] secrets: ${secrets.size}, pid: ${process.pid}`);
