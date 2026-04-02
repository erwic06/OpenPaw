import type { Database } from "bun:sqlite";
import { resolve, dirname } from "path";
import type { Task } from "../plan/types.ts";
import type { AgentInput, AgentOutput } from "./types.ts";
import { DEFAULT_ROSTER } from "./types.ts";
import { LLMAdapter } from "./llm-adapter.ts";
import { CodexAdapter } from "./codex-adapter.ts";
import { executeWithFallback, isRetryableError } from "./fallback.ts";
import { SessionMonitor } from "./monitor.ts";
import {
  createSandbox as realCreateSandbox,
  destroySandbox as realDestroySandbox,
} from "../sandbox/index.ts";
import type { SandboxDeps, SandboxConfig, SandboxHandle } from "../sandbox/types.ts";
import { updateTaskStatus } from "../plan/writer.ts";
import { runCodeReview } from "../review/index.ts";
import type { ReviewResult } from "../review/types.ts";
import { requestApproval as realRequestApproval } from "../gates/index.ts";
import type { GateRequest, GateResult } from "../gates/types.ts";
import type { BudgetEnforcer } from "../budget/index.ts";
import { getTaskFailureCount } from "../db/index.ts";
import type { AlertSystem } from "../alerts/index.ts";
import { traceSession, scrubSecrets, getSecretValues } from "../tracing/index.ts";

const STUCK_TASK_THRESHOLD = 3;

export interface RunnerDeps {
  db: Database;
  sendAlert: (message: string) => Promise<void>;
  anthropicApiKey: string;
  openaiApiKey: string;
  repoMount: string;
  branch: string;
  planPath: string;
  systemPromptPath: string;
  sandboxDeps: SandboxDeps;
  /** Override for testing. */
  createSandboxFn?: (deps: SandboxDeps, config: SandboxConfig) => Promise<SandboxHandle>;
  /** Override for testing. */
  destroySandboxFn?: (sessionId: string) => Promise<void>;
  /** Override full session execution for testing. Replaces adapter+fallback flow. */
  executeSessionFn?: (task: Task, sandbox: SandboxHandle) => Promise<AgentOutput>;
  /** Override for testing. Replaces the entire code review step. */
  runReviewFn?: (task: Task, sandbox: SandboxHandle) => Promise<ReviewResult | null>;
  /** Override for testing. Replaces the HITL deploy gate request. */
  requestApprovalFn?: (request: GateRequest) => Promise<GateResult>;
  /** Optional budget enforcement. When set, drainQueue checks before each dispatch. */
  budgetEnforcer?: BudgetEnforcer;
  /** Optional alert system for structured alerts (stuck task detection). */
  alertSystem?: AlertSystem;
}

/** Session tracking for monitoring cancel/activity routing. */
interface ActiveSession {
  cancel: (sessionId: string) => Promise<void>;
  getLastActivityMs: (sessionId: string) => number | undefined;
}

const MAX_DIFF_CHARS = 2000;

/** Assemble context summary for deploy gate approval request. */
export function assembleDeployContext(
  task: Task,
  output: AgentOutput,
  review: ReviewResult | null,
  diff: string,
): string {
  const lines: string[] = [];

  lines.push(`Task: ${task.id} — ${task.title}`);
  lines.push(`Target: ${task.deploy ?? "unknown"}`);
  lines.push("");

  lines.push("--- Session ---");
  lines.push(`Status: ${output.terminalState}`);
  lines.push(`Cost: $${output.costUsd.toFixed(4)}`);
  lines.push(`Tokens: ${output.usage.inputTokens} in / ${output.usage.outputTokens} out`);
  lines.push("");

  if (review) {
    lines.push("--- Code Review ---");
    lines.push(`Verdict: ${review.verdict}`);
    lines.push(`Summary: ${review.summary}`);
    if (review.findings.length > 0) {
      for (const f of review.findings) {
        lines.push(`  [${f.severity}] ${f.file}:${f.line} — ${f.description}`);
      }
    }
    lines.push("");
  }

  if (diff.trim()) {
    lines.push("--- Git Diff ---");
    if (diff.length > MAX_DIFF_CHARS) {
      lines.push(diff.slice(0, MAX_DIFF_CHARS));
      lines.push(`\n... (truncated, ${diff.length} chars total — full diff available via git)`);
    } else {
      lines.push(diff);
    }
  }

  return lines.join("\n");
}

export class SessionRunner {
  private deps: RunnerDeps;
  private busy = false;
  private queue: Task[] = [];
  private monitor: SessionMonitor;
  private activeSessions = new Map<string, ActiveSession>();
  private stuckTasks = new Set<string>();

  constructor(deps: RunnerDeps) {
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

  isBusy(): boolean {
    return this.busy;
  }

  queueLength(): number {
    return this.queue.length;
  }

  async enqueue(task: Task): Promise<void> {
    this.queue.push(task);
    if (!this.busy) {
      await this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.deps.budgetEnforcer) {
        const proceed = await this.deps.budgetEnforcer.enforceBudget();
        if (!proceed) {
          console.log("[runner] budget exceeded — dispatch paused");
          break;
        }
      }
      this.busy = true;
      const task = this.queue.shift()!;
      if (this.stuckTasks.has(task.id)) {
        console.log(`[runner] skipping stuck task ${task.id} (3+ failures)`);
        this.busy = false;
        continue;
      }
      try {
        await this.runTask(task);
      } catch (err) {
        console.error(`[runner] unhandled error in task ${task.id}: ${err}`);
      }
      this.busy = false;
    }
  }

  async runTask(task: Task): Promise<void> {
    const sandboxId = `sandbox-${task.id.replace(".", "-")}-${Date.now()}`;
    let sandboxHandle: SandboxHandle | undefined;

    console.log(`[runner] starting task ${task.id}: ${task.title}`);

    try {
      // 1. Update plan to in-progress
      await updateTaskStatus(this.deps.planPath, task.id, "in-progress");

      // 2. Create local workspace
      const createFn = this.deps.createSandboxFn ?? realCreateSandbox;
      sandboxHandle = await createFn(this.deps.sandboxDeps, {
        sessionId: sandboxId,
        repoMount: this.deps.repoMount,
        branch: this.deps.branch,
      });

      // 3. Execute session (adapter + fallback, or test override)
      const output = this.deps.executeSessionFn
        ? await this.deps.executeSessionFn(task, sandboxHandle)
        : await this.executeSession(task, sandboxHandle);

      // 4. Code review (only on coder success)
      let finalStatus: string =
        output.terminalState === "complete" ? "complete" : "failed";
      let statusNotes = output.error
        ? `Session error: ${output.error}`
        : undefined;

      let review: ReviewResult | null = null;
      if (finalStatus === "complete" && sandboxHandle) {
        review = await this.reviewChanges(task, sandboxHandle);
        if (review?.verdict === "REQUEST_CHANGES") {
          finalStatus = "failed";
          statusNotes = `Code review rejected: ${review.summary}`;
        }
      }

      // 5. Deploy gate (only on success + deploy-tagged tasks)
      if (finalStatus === "complete" && task.deploy) {
        const gateResult = await this.requestDeployApproval(
          task,
          output,
          sandboxHandle,
          review,
        );
        if (gateResult.decision !== "approved") {
          finalStatus = "blocked";
          statusNotes = `Deploy ${gateResult.decision}: ${task.deploy} deploy for task ${task.id}`;
        }
      }

      // 6. Update plan with result
      await updateTaskStatus(
        this.deps.planPath,
        task.id,
        finalStatus,
        statusNotes,
      );

      // 6. Stuck task detection
      if (finalStatus === "failed") {
        const failCount = getTaskFailureCount(this.deps.db, task.id);
        if (failCount >= STUCK_TASK_THRESHOLD) {
          this.stuckTasks.add(task.id);
          if (this.deps.alertSystem) {
            await this.deps.alertSystem.send({
              type: "stuck_task",
              taskId: task.id,
              taskTitle: task.title,
              failureCount: failCount,
              lastError: statusNotes ?? "unknown",
            });
          }
        }
      }

      // 7. Send notification
      const costStr = `$${output.costUsd.toFixed(4)}`;
      await this.deps.sendAlert(
        `Task ${task.id} (${task.title}) \u2192 ${finalStatus}. Cost: ${costStr}`,
      );

      // 8. Log cost summary
      console.log(
        `[runner] task ${task.id} ${finalStatus} | cost: ${costStr} | tokens: ${output.usage.inputTokens}in/${output.usage.outputTokens}out`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[runner] task ${task.id} failed: ${errorMsg}`);

      try {
        await updateTaskStatus(this.deps.planPath, task.id, "failed", errorMsg);
      } catch {
        /* plan update itself failed */
      }

      try {
        await this.deps.sendAlert(
          `Task ${task.id} (${task.title}) failed: ${errorMsg}`,
        );
      } catch {
        /* alert failed */
      }
    } finally {
      if (sandboxHandle) {
        const destroyFn = this.deps.destroySandboxFn ?? realDestroySandbox;
        try {
          await destroyFn(sandboxId);
        } catch (err) {
          console.error(`[runner] sandbox cleanup failed: ${err}`);
        }
      }
    }
  }

  /** Request deploy approval via HITL gate. */
  private async requestDeployApproval(
    task: Task,
    output: AgentOutput,
    sandbox: SandboxHandle | undefined,
    review: ReviewResult | null,
  ): Promise<GateResult> {
    let diff = "";
    if (sandbox) {
      try {
        diff = await this.getWorkspaceDiff(sandbox);
      } catch {
        diff = "(diff unavailable)";
      }
    }

    const context = assembleDeployContext(task, output, review, diff);
    const requestFn = this.deps.requestApprovalFn ?? realRequestApproval;

    return requestFn({
      gateType: "deploy",
      taskId: task.id,
      sessionId: output.sessionId,
      contextSummary: context,
    });
  }

  /** Run code review on workspace changes. Returns null on failure (soft pass). */
  private async reviewChanges(
    task: Task,
    sandbox: SandboxHandle,
  ): Promise<ReviewResult | null> {
    try {
      if (this.deps.runReviewFn) {
        return await this.deps.runReviewFn(task, sandbox);
      }

      const diff = await this.getWorkspaceDiff(sandbox);
      if (!diff.trim()) return null;

      const repoDir = dirname(this.deps.planPath);
      return await runCodeReview(
        {
          db: this.deps.db,
          anthropicApiKey: this.deps.anthropicApiKey,
          sendAlert: this.deps.sendAlert,
        },
        resolve(repoDir, "agents/reviewer/system_prompt.md"),
        sandbox.workDir,
        task.id,
        diff,
      );
    } catch {
      // Review failure is a soft pass — don't block the task
      return null;
    }
  }

  /** Get all changes in the workspace relative to the initial clone state. */
  private async getWorkspaceDiff(sandbox: SandboxHandle): Promise<string> {
    const proc = Bun.spawn(["git", "diff", `origin/${this.deps.branch}`], {
      cwd: sandbox.workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  }

  /** Full session execution: adapter creation, monitoring, tier-based routing. */
  private async executeSession(
    task: Task,
    sandbox: SandboxHandle,
  ): Promise<AgentOutput> {
    const repoDir = dirname(this.deps.planPath);

    const input: AgentInput = {
      taskId: task.id,
      taskTitle: task.title,
      contractPath: resolve(repoDir, task.contract),
      systemPromptPath: this.deps.systemPromptPath,
      modelTier: "standard",
      tools: [],
      budgetUsd: 5.0,
    };

    const roster = DEFAULT_ROSTER[input.modelTier];

    // Both adapters get cwd pointed at the workspace
    const claudeAdapter = new LLMAdapter({
      db: this.deps.db,
      anthropicApiKey: this.deps.anthropicApiKey,
      cwd: sandbox.workDir,
    });

    const codexAdapter = new CodexAdapter({
      db: this.deps.db,
      openaiApiKey: this.deps.openaiApiKey,
      cwd: sandbox.workDir,
    });

    // Route by model tier: heavy/standard → Claude primary, light → Codex primary
    const primaryAdapter = roster.primary.provider === "anthropic"
      ? claudeAdapter
      : codexAdapter;
    const fallbackAdapter = roster.fallback.provider === "anthropic"
      ? claudeAdapter
      : codexAdapter;

    const makeExecutor =
      (adapter: LLMAdapter | CodexAdapter) =>
      async (): Promise<AgentOutput> => {
        const sessionId = await adapter.trigger(input);
        this.activeSessions.set(sessionId, {
          cancel: (id) => adapter.cancel(id),
          getLastActivityMs: (id) => adapter.getLastActivityMs(id),
        });
        this.monitor.startMonitoring(sessionId);
        try {
          await adapter.waitForCompletion(sessionId);
          const output = await adapter.output(sessionId);
          // Only throw retryable errors for fallback; agent-level failures are returned as-is
          if (
            output.terminalState === "failed" &&
            output.error &&
            isRetryableError(new Error(output.error))
          ) {
            throw new Error(output.error);
          }
          return output;
        } finally {
          this.monitor.stopMonitoring(sessionId);
          this.activeSessions.delete(sessionId);
        }
      };

    const metadata: Record<string, string> = {
      agent: "coder",
      taskId: task.id,
      model: roster.primary.model,
    };
    const secrets = getSecretValues();
    for (const key of Object.keys(metadata)) {
      metadata[key] = scrubSecrets(metadata[key], secrets);
    }

    return traceSession(
      `coder-${task.id}`,
      metadata,
      () =>
        executeWithFallback(
          roster.primary.model,
          roster.fallback.model,
          makeExecutor(primaryAdapter),
          makeExecutor(fallbackAdapter),
          { sendAlert: this.deps.sendAlert },
        ),
    );
  }
}
