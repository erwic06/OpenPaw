import type { AgentDefinition, OutputDestination } from "./types.ts";
import type { AgentOutput } from "../agents/types.ts";
import type { RoutingDeps } from "./router.ts";

const MAX_TELEGRAM_LENGTH = 4000;

export async function routeToTelegram(
  deps: RoutingDeps,
  agentDef: AgentDefinition,
  output: AgentOutput,
  dest: OutputDestination & { type: "telegram" },
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const status = output.terminalState === "complete" ? "Complete" : "Failed";
  const cost = output.costUsd > 0 ? ` · $${output.costUsd.toFixed(2)}` : "";

  if (dest.format === "summary") {
    const summary = buildSummary(output);
    const message =
      `<b>${agentDef.name}</b>\n` +
      `${timestamp} · ${status}${cost}\n\n` +
      summary;
    await deps.sendMessage(deps.chatId, message);
  } else {
    // full_report: send truncated preview
    const preview = buildPreview(output);
    const message =
      `<b>${agentDef.name}</b>\n` +
      `${timestamp} · ${status}${cost}\n\n` +
      preview +
      `\n\n<i>Full report available on GitHub</i>`;
    await deps.sendMessage(deps.chatId, message);
  }
}

function buildSummary(output: AgentOutput): string {
  if (output.error) {
    return `Error: ${output.error}`;
  }
  if (output.artifacts.length > 0) {
    return `Artifacts: ${output.artifacts.join(", ")}`;
  }
  return "Completed successfully.";
}

function buildPreview(output: AgentOutput): string {
  if (output.error) {
    return `Error: ${output.error}`;
  }
  const text = output.artifacts.join("\n");
  if (text.length > MAX_TELEGRAM_LENGTH) {
    return text.slice(0, MAX_TELEGRAM_LENGTH) + "…";
  }
  return text || "No output content.";
}
