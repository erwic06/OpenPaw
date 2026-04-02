import type { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import type { Task } from "../plan/types.ts";
import type { AgentInput, AgentOutput } from "../agents/types.ts";
import { DEFAULT_ROSTER } from "../agents/types.ts";
import { GeminiAdapter } from "../agents/gemini-adapter.ts";
import { isRetryableError } from "../agents/fallback.ts";
import { SessionMonitor } from "../agents/monitor.ts";
import { updateTaskStatus } from "../plan/writer.ts";
import { runResearchReview } from "../review/research.ts";
import type { ReviewResult } from "../review/types.ts";
import { requestApproval as realRequestApproval } from "../gates/index.ts";
import type { GateRequest, GateResult } from "../gates/types.ts";
import { browseUrl, getBrowserUseToolDeclaration } from "../tools/browseruse.ts";
import type { BrowserUseDeps } from "../tools/browseruse.ts";
import { insertSession, updateSession } from "../db/index.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";
import { estimateResearchCost, formatCostEstimate } from "./estimator.ts";
import type { CostEstimate } from "./estimator.ts";
import { DEPTH_CONFIGS } from "./types.ts";
import type { BudgetEnforcer } from "../budget/index.ts";

export interface ResearchRunnerDeps {
  db: Database;
  sendAlert: (message: string) => Promise<void>;
  geminiApiKey: string;
  anthropicApiKey: string;
  browserUseDeps: BrowserUseDeps;
  planPath: string;
  systemPromptPath: string;
  reviewerPromptPath: string;
  /** Override research session execution for testing. */
  executeResearchFn?: (
    task: Task,
    depth: number,
    prompt: string,
  ) => Promise<{ output: AgentOutput; briefText: string }>;
  /** Override fact-check review for testing. */
  runReviewFn?: (taskId: string, brief: string) => Promise<ReviewResult | null>;
  /** Override gate requests for testing. */
  requestApprovalFn?: (request: GateRequest) => Promise<GateResult>;
  /** Override cost estimation for testing. */
  estimateCostFn?: (depth: number, prompt: string) => CostEstimate;
  /** Optional budget enforcement. When set, runResearch checks before cost estimation. */
  budgetEnforcer?: BudgetEnforcer;
}

interface ActiveSession {
  cancel: (sessionId: string) => Promise<void>;
  getLastActivityMs: (sessionId: string) => number | undefined;
}

const MAX_BRIEF_PREVIEW_CHARS = 3000;

export class ResearchRunner {
  private deps: ResearchRunnerDeps;
  private monitor: SessionMonitor;
  private activeSessions = new Map<string, ActiveSession>();

  constructor(deps: ResearchRunnerDeps) {
    this.deps = deps;
    this.monitor = new SessionMonitor({
      cancelSession: async (sessionId) => {
        const session = this.activeSessions.get(sessionId);
        if (session) {
          await session.cancel(sessionId);
          this.activeSessions.delete(sessionId);
        }
      },
      db: deps.db,
      sendAlert: deps.sendAlert,
      getLastActivityMs: (sessionId) => {
        return this.activeSessions.get(sessionId)?.getLastActivityMs(sessionId);
      },
    });
    this.monitor.start();
  }

  stop(): void {
    this.monitor.stop();
  }

  async runResearch(task: Task, depth: number, prompt: string): Promise<void> {
    console.log(
      `[research-runner] starting ${task.id}: ${task.title} (depth ${depth})`,
    );

    try {
      // 0. Budget check
      if (this.deps.budgetEnforcer) {
        const proceed = await this.deps.budgetEnforcer.enforceBudget();
        if (!proceed) {
          console.log("[research-runner] budget exceeded — dispatch paused");
          return;
        }
      }

      // 1. Cost estimation
      const estimateFn = this.deps.estimateCostFn ?? estimateResearchCost;
      const estimate = estimateFn(depth, prompt);

      // 2. Cost confirmation via spend gate
      const requestFn = this.deps.requestApprovalFn ?? realRequestApproval;
      const costResult = await requestFn({
        gateType: "spend",
        taskId: task.id,
        sessionId: null,
        contextSummary: formatCostEstimate(estimate, prompt),
      });

      if (costResult.decision !== "approved") {
        await updateTaskStatus(
          this.deps.planPath,
          task.id,
          "blocked",
          `Cost estimate ${costResult.decision}`,
        );
        await this.deps.sendAlert(
          `Research ${task.id} \u2014 cost estimate ${costResult.decision}`,
        );
        return;
      }

      // 3. Mark in-progress
      await updateTaskStatus(this.deps.planPath, task.id, "in-progress");

      // 4. Execute researcher session
      const { output, briefText } = this.deps.executeResearchFn
        ? await this.deps.executeResearchFn(task, depth, prompt)
        : await this.executeDefaultResearch(task, depth, prompt);

      if (output.terminalState !== "complete" || !briefText.trim()) {
        const errorMsg = output.error ?? "Research session produced no output";
        await updateTaskStatus(this.deps.planPath, task.id, "failed", errorMsg);
        await this.deps.sendAlert(
          `Research ${task.id} failed: ${errorMsg}`,
        );
        return;
      }

      // 5. Fact-check review
      const review = this.deps.runReviewFn
        ? await this.deps.runReviewFn(task.id, briefText)
        : await runResearchReview(
            {
              db: this.deps.db,
              anthropicApiKey: this.deps.anthropicApiKey,
              sendAlert: this.deps.sendAlert,
            },
            this.deps.reviewerPromptPath,
            ".",
            task.id,
            briefText,
          );

      if (review?.verdict === "REQUEST_CHANGES") {
        const msg = `Fact-check rejected: ${review.summary}`;
        await updateTaskStatus(this.deps.planPath, task.id, "failed", msg);
        await this.deps.sendAlert(`Research ${task.id} \u2014 ${msg}`);
        return;
      }

      // 6. Gate 3: research brief approval
      const briefContext = assembleBriefContext(task, output, review, briefText);
      const gateResult = await requestFn({
        gateType: "research",
        taskId: task.id,
        sessionId: output.sessionId,
        contextSummary: briefContext,
      });

      // 7. Final status
      if (gateResult.decision === "approved") {
        await updateTaskStatus(this.deps.planPath, task.id, "complete");
        const costStr = `$${output.costUsd.toFixed(4)}`;
        await this.deps.sendAlert(
          `Research ${task.id} (${task.title}) \u2192 complete. Cost: ${costStr}`,
        );
      } else {
        await updateTaskStatus(
          this.deps.planPath,
          task.id,
          "blocked",
          `Research brief ${gateResult.decision}`,
        );
        await this.deps.sendAlert(
          `Research ${task.id} \u2014 brief ${gateResult.decision}`,
        );
      }

      console.log(
        `[research-runner] ${task.id} done | cost: $${output.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[research-runner] ${task.id} failed: ${errorMsg}`);

      try {
        await updateTaskStatus(this.deps.planPath, task.id, "failed", errorMsg);
      } catch {
        /* plan update failed */
      }
      try {
        await this.deps.sendAlert(`Research ${task.id} failed: ${errorMsg}`);
      } catch {
        /* alert failed */
      }
    }
  }

  private async executeDefaultResearch(
    task: Task,
    depth: number,
    prompt: string,
  ): Promise<{ output: AgentOutput; briefText: string }> {
    const config = DEPTH_CONFIGS[depth] ?? DEPTH_CONFIGS[5];

    const researchPrompt = [
      `Research task ${task.id}: ${task.title}`,
      `Depth: ${depth}/10`,
      `Minimum sources: ${config.minSources}`,
      `Output token budget: ${config.outputTokenBudget}`,
      "",
      prompt,
    ].join("\n");

    // Write prompt to temp file for GeminiAdapter's contractPath
    const tmpPromptPath = join(
      tmpdir(),
      `research-${task.id.replace(/\./g, "-")}-${Date.now()}.md`,
    );
    await Bun.write(tmpPromptPath, researchPrompt);

    const input: AgentInput = {
      taskId: task.id,
      taskTitle: task.title,
      contractPath: tmpPromptPath,
      systemPromptPath: this.deps.systemPromptPath,
      modelTier: "research",
      tools: [JSON.stringify(getBrowserUseToolDeclaration())],
      budgetUsd: config.estimatedCostRange[1],
    };

    const roster = DEFAULT_ROSTER["research"];

    try {
      // Primary: Gemini with BrowserUse
      try {
        return await this.runGeminiSession(input);
      } catch (primaryErr) {
        if (!isRetryableError(primaryErr as Error)) throw primaryErr;

        await this.deps.sendAlert(
          `Research fallback: ${roster.primary.model} \u2192 ${roster.fallback.model}`,
        );

        // Fallback: Claude Sonnet via Agent SDK (no BrowserUse)
        return await this.runClaudeFallbackSession(task.id, researchPrompt);
      }
    } finally {
      try {
        unlinkSync(tmpPromptPath);
      } catch {
        /* cleanup best-effort */
      }
    }
  }

  private async runGeminiSession(
    input: AgentInput,
  ): Promise<{ output: AgentOutput; briefText: string }> {
    const adapter = new GeminiAdapter({
      db: this.deps.db,
      geminiApiKey: this.deps.geminiApiKey,
      toolExecutor: async (name, args) => {
        if (name === "browse_url") {
          return await browseUrl(this.deps.browserUseDeps, args.url as string, {
            action: args.action as string | undefined,
          });
        }
        return { error: `Unknown tool: ${name}` };
      },
    });

    const sessionId = await adapter.trigger(input);
    this.activeSessions.set(sessionId, {
      cancel: (id) => adapter.cancel(id),
      getLastActivityMs: (id) => adapter.getLastActivityMs(id),
    });
    this.monitor.startMonitoring(sessionId);

    try {
      await adapter.waitForCompletion(sessionId);
      const output = await adapter.output(sessionId);
      const briefText = adapter.getResultText(sessionId);

      if (
        output.terminalState === "failed" &&
        output.error &&
        isRetryableError(new Error(output.error))
      ) {
        throw new Error(output.error);
      }

      return { output, briefText };
    } finally {
      this.monitor.stopMonitoring(sessionId);
      this.activeSessions.delete(sessionId);
    }
  }

  private async runClaudeFallbackSession(
    taskId: string,
    prompt: string,
  ): Promise<{ output: AgentOutput; briefText: string }> {
    const sessionId = `research-fallback-${taskId.replace(/\./g, "-")}-${Date.now()}`;
    const systemPrompt = await Bun.file(this.deps.systemPromptPath).text();

    insertSession(this.deps.db, {
      id: sessionId,
      agent: "researcher",
      task_id: taskId,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      started_at: new Date().toISOString(),
    });

    try {
      const { query: sdkQuery } = await import(
        "@anthropic-ai/claude-agent-sdk"
      );
      type SDKResultMessage =
        import("@anthropic-ai/claude-agent-sdk").SDKResultMessage;

      const iter = sdkQuery({
        prompt,
        options: {
          systemPrompt,
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxBudgetUsd: 5.0,
          cwd: ".",
          persistSession: false,
          env: { ANTHROPIC_API_KEY: this.deps.anthropicApiKey },
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

      if (inputTokens > 0 || outputTokens > 0) {
        logUsage(
          { db: this.deps.db },
          sessionId,
          "claude-sonnet-4-6",
          "anthropic",
          inputTokens,
          outputTokens,
        );
      }

      const costUsd = getSessionCost({ db: this.deps.db }, sessionId);

      updateSession(this.deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: "complete",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
      });

      return {
        output: {
          sessionId,
          terminalState: "complete",
          artifacts: [],
          usage: { inputTokens, outputTokens },
          costUsd,
          error: null,
        },
        briefText: resultText,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      updateSession(this.deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: "failed",
        error: errorMsg,
      });

      return {
        output: {
          sessionId,
          terminalState: "failed",
          artifacts: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          error: errorMsg,
        },
        briefText: "",
      };
    }
  }
}

export function assembleBriefContext(
  task: Task,
  output: AgentOutput,
  review: ReviewResult | null,
  briefText: string,
): string {
  const lines: string[] = [];
  lines.push(`Task: ${task.id} \u2014 ${task.title}`);
  lines.push(`Cost: $${output.costUsd.toFixed(4)}`);
  lines.push(
    `Tokens: ${output.usage.inputTokens} in / ${output.usage.outputTokens} out`,
  );
  lines.push("");

  if (review) {
    lines.push("--- Fact-Check Review ---");
    lines.push(`Verdict: ${review.verdict}`);
    lines.push(`Summary: ${review.summary}`);
    if (review.findings.length > 0) {
      for (const f of review.findings) {
        lines.push(`  [${f.severity}] ${f.description}`);
      }
    }
    lines.push("");
  }

  lines.push("--- Brief Preview ---");
  if (briefText.length > MAX_BRIEF_PREVIEW_CHARS) {
    lines.push(briefText.slice(0, MAX_BRIEF_PREVIEW_CHARS));
    lines.push(`\n... (${briefText.length} chars total)`);
  } else {
    lines.push(briefText);
  }

  return lines.join("\n");
}
