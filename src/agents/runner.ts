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
  destroySandboxFn?: (deps: SandboxDeps, sessionId: string) => Promise<void>;
  /** Override full session execution for testing. Replaces adapter+fallback flow. */
  executeSessionFn?: (task: Task, sandbox: SandboxHandle) => Promise<AgentOutput>;
}

/** Session tracking for monitoring cancel/activity routing. */
interface ActiveSession {
  cancel: (sessionId: string) => Promise<void>;
  getLastActivityMs: (sessionId: string) => number | undefined;
}

export class SessionRunner {
  private deps: RunnerDeps;
  private busy = false;
  private queue: Task[] = [];
  private monitor: SessionMonitor;
  private activeSessions = new Map<string, ActiveSession>();

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
      this.busy = true;
      const task = this.queue.shift()!;
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

      // 4. Update plan with result
      const finalStatus = output.terminalState === "complete" ? "complete" : "failed";
      const statusNotes = output.error
        ? `Session error: ${output.error}`
        : undefined;
      await updateTaskStatus(
        this.deps.planPath,
        task.id,
        finalStatus,
        statusNotes,
      );

      // 5. Send notification
      const costStr = `$${output.costUsd.toFixed(4)}`;
      await this.deps.sendAlert(
        `Task ${task.id} (${task.title}) \u2192 ${finalStatus}. Cost: ${costStr}`,
      );

      // 6. Log cost summary
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
          await destroyFn(this.deps.sandboxDeps, sandboxId);
        } catch (err) {
          console.error(`[runner] sandbox cleanup failed: ${err}`);
        }
      }
    }
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

    return executeWithFallback(
      roster.primary.model,
      roster.fallback.model,
      makeExecutor(primaryAdapter),
      makeExecutor(fallbackAdapter),
      { sendAlert: this.deps.sendAlert },
    );
  }
}
