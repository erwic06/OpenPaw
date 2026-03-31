import type { Database } from "bun:sqlite";
import type {
  Codex,
  Thread,
  ThreadEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { AgentAdapter, AgentInput, AgentOutput, AgentStatus } from "./types.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";
import { insertSession, updateSession } from "../db/index.ts";

/** Factory function that creates a Codex instance. Overridable for testing. */
export type CodexFactory = (apiKey: string) => CodexLike;

/** Minimal interface matching the Codex SDK methods we use. */
export interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
}

/** Minimal interface matching the Thread methods we use. */
export interface ThreadLike {
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

/** Injected dependencies for testability. */
export interface CodexAdapterDeps {
  db: Database;
  openaiApiKey: string;
  /** Working directory for the Codex session. */
  cwd?: string;
  /** Override Codex factory for testing. */
  codexFactory?: CodexFactory;
}

/** In-memory state for a running or completed session. */
interface SessionState {
  status: AgentStatus;
  abortController: AbortController;
  lastActivityMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  resultText: string;
  error: string | null;
  model: string;
  runPromise: Promise<void>;
}

function generateSessionId(): string {
  return `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MODEL_MAP: Record<string, string> = {
  heavy: "gpt-5.4",
  standard: "gpt-5.4",
  light: "gpt-5.4-mini",
};

export class CodexAdapter implements AgentAdapter {
  private deps: CodexAdapterDeps;
  private sessions = new Map<string, SessionState>();

  constructor(deps: CodexAdapterDeps) {
    this.deps = deps;
  }

  async trigger(input: AgentInput): Promise<string> {
    const sessionId = generateSessionId();
    const controller = new AbortController();
    const model = MODEL_MAP[input.modelTier] ?? "gpt-5.4";
    const now = Date.now();

    const state: SessionState = {
      status: "running",
      abortController: controller,
      lastActivityMs: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      resultText: "",
      error: null,
      model,
      runPromise: Promise.resolve(),
    };

    this.sessions.set(sessionId, state);

    insertSession(this.deps.db, {
      id: sessionId,
      agent: "coder",
      task_id: input.taskId,
      model,
      provider: "openai",
      started_at: new Date(now).toISOString(),
    });

    let systemPrompt: string | undefined;
    if (input.systemPromptPath) {
      systemPrompt = await Bun.file(input.systemPromptPath).text();
    }

    const contractContent = await Bun.file(input.contractPath).text();
    let prompt = `Execute task ${input.taskId}: ${input.taskTitle}\n\n${contractContent}`;
    if (systemPrompt) {
      prompt = `${systemPrompt}\n\n---\n\n${prompt}`;
    }

    state.runPromise = this.runSession(sessionId, state, {
      prompt,
      model,
      controller,
    });

    return sessionId;
  }

  async status(sessionId: string): Promise<AgentStatus> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    return state.status;
  }

  async output(sessionId: string): Promise<AgentOutput> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    return {
      sessionId,
      terminalState: state.status === "complete" ? "complete" : "failed",
      artifacts: [],
      usage: {
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
      },
      costUsd: getSessionCost({ db: this.deps.db }, sessionId),
      error: state.error,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    state.abortController.abort();
    state.status = "failed";
    state.error = "Cancelled by user";
    updateSession(this.deps.db, sessionId, {
      ended_at: new Date().toISOString(),
      terminal_state: "failed",
      error: "Cancelled by user",
    });
  }

  getLastActivityMs(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.lastActivityMs;
  }

  async waitForCompletion(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    await state.runPromise;
  }

  private async runSession(
    sessionId: string,
    state: SessionState,
    opts: {
      prompt: string;
      model: string;
      controller: AbortController;
    },
  ): Promise<void> {
    try {
      const codex = this.createCodex();
      const thread = codex.startThread({
        model: opts.model,
        workingDirectory: this.deps.cwd,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });

      const { events } = await thread.runStreamed(opts.prompt, {
        signal: opts.controller.signal,
      });

      for await (const event of events) {
        if (opts.controller.signal.aborted) break;

        state.lastActivityMs = Date.now();
        this.processEvent(sessionId, state, event);
      }

      if (opts.controller.signal.aborted) return;

      if (state.status === "running") {
        state.status = "complete";
      }

      updateSession(this.deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: state.status === "complete" ? "complete" : "failed",
        input_tokens: state.totalInputTokens,
        output_tokens: state.totalOutputTokens,
        cost_usd: getSessionCost({ db: this.deps.db }, sessionId),
        error: state.error,
      });
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      updateSession(this.deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: "failed",
        input_tokens: state.totalInputTokens,
        output_tokens: state.totalOutputTokens,
        cost_usd: getSessionCost({ db: this.deps.db }, sessionId),
        error: state.error,
      });
    }
  }

  private processEvent(
    sessionId: string,
    state: SessionState,
    event: ThreadEvent,
  ): void {
    switch (event.type) {
      case "turn.completed": {
        const tc = event as TurnCompletedEvent;
        if (tc.usage) {
          state.totalInputTokens += tc.usage.input_tokens;
          state.totalOutputTokens += tc.usage.output_tokens;

          if (tc.usage.input_tokens > 0 || tc.usage.output_tokens > 0) {
            logUsage(
              { db: this.deps.db },
              sessionId,
              state.model,
              "openai",
              tc.usage.input_tokens,
              tc.usage.output_tokens,
            );
          }
        }
        state.status = "complete";
        break;
      }
      case "turn.failed": {
        const tf = event as TurnFailedEvent;
        state.status = "failed";
        state.error = tf.error?.message ?? "Turn failed";
        break;
      }
      case "item.completed": {
        if (event.item.type === "agent_message") {
          state.resultText = event.item.text;
        }
        break;
      }
      case "error": {
        state.status = "failed";
        state.error = event.message;
        break;
      }
    }
  }

  private createCodex(): CodexLike {
    if (this.deps.codexFactory) {
      return this.deps.codexFactory(this.deps.openaiApiKey);
    }
    const { Codex } = require("@openai/codex-sdk");
    return new Codex({ apiKey: this.deps.openaiApiKey });
  }
}
