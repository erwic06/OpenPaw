import type { ReviewResult } from "./types.ts";
import type { ReviewDeps, ReviewExecutor } from "./index.ts";
import { parseReviewResult } from "./index.ts";
import { insertSession, updateSession } from "../db/index.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";

/**
 * Run a Claude Reviewer session to fact-check a research brief.
 * Returns null on session failure (soft pass — review failure shouldn't block research).
 */
export async function runResearchReview(
  deps: ReviewDeps,
  systemPromptPath: string,
  cwd: string,
  taskId: string,
  brief: string,
): Promise<ReviewResult | null> {
  const sessionId = `research-review-${taskId.replace(".", "-")}-${Date.now()}`;

  try {
    const systemPrompt = await Bun.file(systemPromptPath).text();
    const prompt = buildResearchReviewPrompt(taskId, brief);

    insertSession(deps.db, {
      id: sessionId,
      agent: "researcher-reviewer",
      task_id: taskId,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      started_at: new Date().toISOString(),
    });

    const execute = deps.executor ?? makeDefaultExecutor(deps.anthropicApiKey);
    const { resultText, inputTokens, outputTokens } = await execute(
      prompt,
      systemPrompt,
      cwd,
    );

    if (inputTokens > 0 || outputTokens > 0) {
      logUsage(
        { db: deps.db },
        sessionId,
        "claude-sonnet-4-6",
        "anthropic",
        inputTokens,
        outputTokens,
      );
    }

    const result = parseReviewResult(resultText);

    updateSession(deps.db, sessionId, {
      ended_at: new Date().toISOString(),
      terminal_state: "complete",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: getSessionCost({ db: deps.db }, sessionId),
    });

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    try {
      updateSession(deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: "failed",
        error: errorMsg,
      });
    } catch {
      /* DB update failed — session may not have been inserted yet */
    }

    await deps.sendAlert(
      `Research review session failed for task ${taskId}: ${errorMsg}`,
    );
    return null;
  }
}

export function buildResearchReviewPrompt(taskId: string, brief: string): string {
  return [
    `Fact-check the following research brief for task ${taskId}.`,
    "",
    "Return ONLY a JSON object with your review findings. No other text.",
    "",
    "```markdown",
    brief,
    "```",
  ].join("\n");
}

/** Import the Agent SDK lazily to avoid test-time import issues. */
function makeDefaultExecutor(anthropicApiKey: string): ReviewExecutor {
  return async (prompt, systemPrompt, cwd) => {
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    type SDKResultMessage = import("@anthropic-ai/claude-agent-sdk").SDKResultMessage;

    const iter = sdkQuery({
      prompt,
      options: {
        systemPrompt,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxBudgetUsd: 0.50,
        cwd,
        persistSession: false,
        env: { ANTHROPIC_API_KEY: anthropicApiKey },
      },
    });

    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const message of iter) {
      if (message.type === "result") {
        const result = message as SDKResultMessage;
        if (result.subtype === "success") {
          resultText = result.result;
        }
        inputTokens = result.usage?.input_tokens ?? 0;
        outputTokens = result.usage?.output_tokens ?? 0;
      }
    }

    return { resultText, inputTokens, outputTokens };
  };
}
