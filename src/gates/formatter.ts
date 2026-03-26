import type { GateType } from "./types.ts";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatGateMessage(
  gateId: string,
  gateType: GateType,
  label: string,
  contextSummary: string,
  taskId: string | null,
  sessionId: string | null,
): string {
  const lines: string[] = [
    `\u{1F512} <b>APPROVAL REQUIRED: ${escapeHtml(label)}</b>`,
    "",
    `<b>Gate:</b> <code>${escapeHtml(gateId)}</code>`,
    `<b>Type:</b> ${escapeHtml(gateType)}`,
  ];

  if (taskId) lines.push(`<b>Task:</b> ${escapeHtml(taskId)}`);
  if (sessionId) lines.push(`<b>Session:</b> ${escapeHtml(sessionId)}`);

  lines.push("", `<b>Context:</b> ${escapeHtml(contextSummary)}`);
  lines.push("", `\u{2192} Reply <b>approve</b> or <b>deny</b>`);

  return lines.join("\n");
}
