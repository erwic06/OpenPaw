import type { AlertPayload } from "./types.ts";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  return `${minutes}m`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

interface AlertTemplate {
  emoji: string;
  title: string;
  fields: [string, string][];
  footer: string;
}

function buildTemplate(payload: AlertPayload): AlertTemplate {
  switch (payload.type) {
    case "session_failed":
      return {
        emoji: "\u26a0\ufe0f",
        title: "SESSION FAILED",
        fields: [
          ["Task", `${payload.taskId} \u2014 ${payload.taskTitle}`],
          ["Agent", `${payload.agent} (${payload.model})`],
          ["Duration", formatDuration(payload.durationMs)],
          ["Error", payload.error],
          ["Cost", formatCost(payload.costUsd)],
        ],
        footer:
          "Task marked FAILED in plan. Next session will retry.",
      };

    case "session_blocked":
      return {
        emoji: "\ud83d\udeab",
        title: "SESSION BLOCKED",
        fields: [
          ["Task", `${payload.taskId} \u2014 ${payload.taskTitle}`],
          ["Agent", `${payload.agent} (${payload.model})`],
          ["Reason", payload.reason],
        ],
        footer: "Task marked BLOCKED in plan. Manual intervention required.",
      };

    case "budget_warning":
      return {
        emoji: "\ud83d\udcb0",
        title: "BUDGET WARNING",
        fields: [
          ["Daily Spend", formatCost(payload.dailySpendUsd)],
          ["Daily Limit", formatCost(payload.dailyLimitUsd)],
          ["Threshold", `${payload.thresholdPct}%`],
        ],
        footer: "Approaching daily budget limit.",
      };

    case "budget_hard_stop":
      return {
        emoji: "\ud83d\uded1",
        title: "BUDGET HARD STOP",
        fields: [
          ["Daily Spend", formatCost(payload.dailySpendUsd)],
          ["Daily Limit", formatCost(payload.dailyLimitUsd)],
        ],
        footer:
          "Daily budget exhausted. No new sessions until tomorrow.",
      };

    case "stuck_task":
      return {
        emoji: "\ud83d\udd04",
        title: "STUCK TASK",
        fields: [
          ["Task", `${payload.taskId} \u2014 ${payload.taskTitle}`],
          ["Failures", String(payload.failureCount)],
          ["Last Error", payload.lastError],
        ],
        footer:
          "Task paused after repeated failures. Manual investigation needed.",
      };

    case "orchestrator_restart":
      return {
        emoji: "\ud83d\udd04",
        title: "ORCHESTRATOR RESTART",
        fields: [
          ["Orphaned Sessions", String(payload.orphanedCount)],
          ["Tasks", payload.taskIds.join(", ")],
        ],
        footer:
          "Orphaned sessions marked FAILED. Affected tasks reset to ready.",
      };

    case "fallback_activated":
      return {
        emoji: "\u21a9\ufe0f",
        title: "FALLBACK ACTIVATED",
        fields: [
          ["Primary", payload.primaryModel],
          ["Fallback", payload.fallbackModel],
          ...(payload.taskId
            ? ([["Task", payload.taskId]] as [string, string][])
            : []),
          ["Error", payload.error],
        ],
        footer: "Switched to fallback model. Session continuing.",
      };
  }
}

export function formatAlertMessage(payload: AlertPayload): string {
  const { emoji, title, fields, footer } = buildTemplate(payload);

  const lines: string[] = [`${emoji} <b>${escapeHtml(title)}</b>`];

  for (const [key, value] of fields) {
    lines.push(`<b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`);
  }

  lines.push(`\u2192 ${escapeHtml(footer)}`);

  return lines.join("\n");
}
