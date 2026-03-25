import { Bot } from "grammy";

// --- Types ---

export interface SendMessageOptions {
  parseMode?: "HTML" | "MarkdownV2";
  disableNotification?: boolean;
}

export type MessageHandler = (
  chatId: number,
  text: string,
) => void | Promise<void>;

export interface AlertData {
  emoji: string;
  title: string;
  fields: [string, string][];
  footer?: string;
}

// --- Module state ---

let bot: Bot | null = null;
let authorizedChatId: number | null = null;
const handlers: MessageHandler[] = [];

// --- Lifecycle ---

export function createBot(token: string, chatId: string): Bot {
  if (bot) throw new Error("[telegram] bot already initialized");

  authorizedChatId = parseInt(chatId, 10);
  if (Number.isNaN(authorizedChatId)) {
    throw new Error(`[telegram] invalid chat ID: ${chatId}`);
  }

  bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.id !== authorizedChatId) {
      console.warn(
        `[telegram] ignored message from unauthorized chat ${ctx.chat.id}`,
      );
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(ctx.chat.id, ctx.message.text);
      } catch (err) {
        console.error("[telegram] handler error:", err);
      }
    }
  });

  bot.catch((err) => {
    console.error("[telegram] bot error:", err.error);
  });

  return bot;
}

/**
 * Start long-polling. grammy handles transient network errors and
 * reconnects automatically. Do not await — polling runs until stopBot().
 */
export function startBot(): void {
  if (!bot) throw new Error("[telegram] bot not initialized");

  bot.start({
    onStart: () => console.log("[telegram] connected (long-polling)"),
    drop_pending_updates: true,
  });
}

/**
 * Stop polling and release the bot instance.
 * Registered handlers are preserved so a subsequent createBot + startBot
 * reconnects with the same handler set.
 */
export async function stopBot(): Promise<void> {
  if (!bot) return;
  await bot.stop();
  bot = null;
  console.log("[telegram] stopped");
}

// --- Messaging ---

export async function sendMessage(
  chatId: number | string,
  text: string,
  options?: SendMessageOptions,
): Promise<void> {
  if (!bot) throw new Error("[telegram] bot not initialized");

  await bot.api.sendMessage(chatId, text, {
    parse_mode: options?.parseMode ?? "HTML",
    disable_notification: options?.disableNotification,
  });
}

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler);
}

// --- Formatting ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format an alert per design doc Section 5:
 *
 *   ⚠️ <b>SESSION FAILED</b>
 *   <b>Task:</b> 2.3 — Implement auth middleware
 *   <b>Agent:</b> Coder (claude-sonnet-4-6)
 *   → Task marked FAILED in plan.
 */
export function formatAlert(data: AlertData): string {
  const lines: string[] = [
    `${data.emoji} <b>${escapeHtml(data.title)}</b>`,
  ];

  for (const [key, value] of data.fields) {
    lines.push(`<b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`);
  }

  if (data.footer) {
    lines.push(`→ ${escapeHtml(data.footer)}`);
  }

  return lines.join("\n");
}
