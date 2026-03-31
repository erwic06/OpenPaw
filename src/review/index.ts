import type { Database } from "bun:sqlite";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewResult, ReviewFinding, ReviewVerdict } from "./types.ts";
import { insertSession, updateSession } from "../db/index.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";

export type { ReviewResult, ReviewFinding, ReviewVerdict } from "./types.ts";

/**
 * Simplified session executor for DI/testing.
 * In production, wraps the Agent SDK query. In tests, returns canned text.
 */
export type ReviewExecutor = (
  prompt: string,
  systemPrompt: string,
  cwd: string,
) => Promise<{ resultText: string; inputTokens: number; outputTokens: number }>;

export interface ReviewDeps {
  db: Database;
  anthropicApiKey: string;
  sendAlert: (message: string) => Promise<void>;
  /** Override for testing. Replaces the SDK query call. */
  executor?: ReviewExecutor;
}

/**
 * Run a Claude Reviewer session against a git diff.
 * Returns null on session failure (soft pass — review failure shouldn't block shipping).
 */
export async function runCodeReview(
  deps: ReviewDeps,
  systemPromptPath: string,
  cwd: string,
  taskId: string,
  diff: string,
): Promise<ReviewResult | null> {
  const sessionId = `review-${taskId.replace(".", "-")}-${Date.now()}`;

  try {
    const systemPrompt = await Bun.file(systemPromptPath).text();
    const prompt = buildReviewPrompt(taskId, diff);

    insertSession(deps.db, {
      id: sessionId,
      agent: "reviewer",
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
      `Review session failed for task ${taskId}: ${errorMsg}`,
    );
    return null;
  }
}

export function buildReviewPrompt(taskId: string, diff: string): string {
  return [
    `Review the following code changes for task ${taskId}.`,
    "",
    "Return ONLY a JSON object with your review findings. No other text.",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * Parse structured review result from raw session output.
 * Handles bare JSON and code-fenced JSON.
 */
export function parseReviewResult(text: string): ReviewResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty review output");
  }

  let json: string;

  // Try code-fenced JSON (more specific match first)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    json = fenceMatch[1].trim();
  } else if (trimmed.startsWith("{")) {
    // Bare JSON
    json = trimmed;
  } else {
    throw new Error("No JSON found in review output");
  }

  return validateReviewResult(JSON.parse(json));
}

function validateReviewResult(obj: unknown): ReviewResult {
  if (!obj || typeof obj !== "object") {
    throw new Error("Review result is not an object");
  }

  const r = obj as Record<string, unknown>;

  if (r.verdict !== "APPROVE" && r.verdict !== "REQUEST_CHANGES") {
    throw new Error(`Invalid verdict: ${String(r.verdict)}`);
  }

  if (typeof r.summary !== "string") {
    throw new Error("Missing or invalid summary");
  }

  if (!Array.isArray(r.findings)) {
    throw new Error("Missing or invalid findings array");
  }

  return {
    verdict: r.verdict as ReviewVerdict,
    summary: r.summary,
    findings: (r.findings as unknown[]).map(validateFinding),
  };
}

function validateFinding(f: unknown): ReviewFinding {
  if (!f || typeof f !== "object") {
    throw new Error("Finding is not an object");
  }

  const finding = f as Record<string, unknown>;
  const validSeverities = ["critical", "major", "minor", "nit"];

  if (!validSeverities.includes(finding.severity as string)) {
    throw new Error(`Invalid severity: ${String(finding.severity)}`);
  }

  return {
    severity: finding.severity as ReviewFinding["severity"],
    file: String(finding.file ?? ""),
    line: Number(finding.line ?? 0),
    description: String(finding.description ?? ""),
  };
}

function makeDefaultExecutor(anthropicApiKey: string): ReviewExecutor {
  return async (prompt, systemPrompt, cwd) => {
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
