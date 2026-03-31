import type { Database } from "bun:sqlite";
import type {
  Query,
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentInput, AgentOutput, AgentStatus } from "./types.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";
import { insertSession, updateSession } from "../db/index.ts";

/** Injected dependencies for testability. */
export interface LLMAdapterDeps {
  db: Database;
  anthropicApiKey: string;
  /** Extra env vars passed to the Claude Code subprocess. */
  env?: Record<string, string>;
  /** MCP server configs passed to query(). Set by orchestrator per session. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Override query() for testing. */
  queryFn?: typeof sdkQuery;
}

/** In-memory state for a running or completed session. */
interface SessionState {
  status: AgentStatus;
  abortController: AbortController;
  /** Unix ms timestamp of last SDK message received. Exposed for session monitoring (Task 3.8). */
  lastActivityMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  resultText: string;
  artifacts: string[];
  error: string | null;
  model: string;
  provider: string;
  /** The background promise driving the session. */
  runPromise: Promise<void>;
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LLMAdapter implements AgentAdapter {
  private deps: LLMAdapterDeps;
  private sessions = new Map<string, SessionState>();

  constructor(deps: LLMAdapterDeps) {
    this.deps = deps;
  }

  /**
   * Start a headless Claude Code session.
   * Returns immediately with a session ID; the session runs in the background.
   */
  async trigger(input: AgentInput): Promise<string> {
    const sessionId = generateSessionId();
    const controller = new AbortController();
    const model = input.modelTier === "heavy"
      ? "claude-opus-4-6"
      : input.modelTier === "standard"
        ? "claude-sonnet-4-6"
        : "claude-haiku-4-5";
    const provider = "anthropic";
    const now = Date.now();

    const state: SessionState = {
      status: "running",
      abortController: controller,
      lastActivityMs: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      resultText: "",
      artifacts: [],
      error: null,
      model,
      provider,
      runPromise: Promise.resolve(),
    };

    this.sessions.set(sessionId, state);

    // Insert session record into SQLite.
    insertSession(this.deps.db, {
      id: sessionId,
      agent: "coder",
      task_id: input.taskId,
      model,
      provider,
      started_at: new Date(now).toISOString(),
    });

    // Read system prompt if path provided.
    let systemPrompt: string | undefined;
    if (input.systemPromptPath) {
      systemPrompt = await Bun.file(input.systemPromptPath).text();
    }

    // Build query prompt from contract.
    const contractContent = await Bun.file(input.contractPath).text();
    const prompt = `Execute task ${input.taskId}: ${input.taskTitle}\n\n${contractContent}`;

    // Start session in background.
    state.runPromise = this.runSession(sessionId, state, {
      prompt,
      systemPrompt,
      model,
      controller,
      budgetUsd: input.budgetUsd,
    });

    return sessionId;
  }

  async status(sessionId: string): Promise<AgentStatus> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return state.status;
  }

  async output(sessionId: string): Promise<AgentOutput> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return {
      sessionId,
      terminalState: state.status === "complete" ? "complete" : "failed",
      artifacts: state.artifacts,
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
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    state.abortController.abort();
    state.status = "failed";
    state.error = "Cancelled by user";

    updateSession(this.deps.db, sessionId, {
      ended_at: new Date().toISOString(),
      terminal_state: "failed",
      error: "Cancelled by user",
    });
  }

  /** Get the last activity timestamp for a session (for monitoring in Task 3.8). */
  getLastActivityMs(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.lastActivityMs;
  }

  /** Wait for a session to reach a terminal state. */
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
      systemPrompt: string | undefined;
      model: string;
      controller: AbortController;
      budgetUsd: number;
    },
  ): Promise<void> {
    const queryFn = this.deps.queryFn ?? sdkQuery;

    try {
      const queryIter: Query = queryFn({
        prompt: opts.prompt,
        options: {
          systemPrompt: opts.systemPrompt,
          model: opts.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: opts.controller,
          maxBudgetUsd: opts.budgetUsd,
          mcpServers: this.deps.mcpServers,
          persistSession: false,
          env: {
            ANTHROPIC_API_KEY: this.deps.anthropicApiKey,
            ...this.deps.env,
          },
        },
      });

      for await (const message of queryIter) {
        if (opts.controller.signal.aborted) break;

        state.lastActivityMs = Date.now();
        this.processMessage(sessionId, state, message);
      }

      // Finalize: if cancelled, cancel() already handled DB update.
      if (opts.controller.signal.aborted) return;

      // Default to complete if result message didn't set a terminal state.
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

  private processMessage(
    sessionId: string,
    state: SessionState,
    message: SDKMessage,
  ): void {
    switch (message.type) {
      case "assistant": {
        const msg = message as SDKAssistantMessage;
        const usage = msg.message?.usage;
        if (usage) {
          const inputTokens = usage.input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          state.totalInputTokens += inputTokens;
          state.totalOutputTokens += outputTokens;

          if (inputTokens > 0 || outputTokens > 0) {
            logUsage(
              { db: this.deps.db },
              sessionId,
              state.model,
              state.provider,
              inputTokens,
              outputTokens,
            );
          }
        }
        break;
      }
      case "result": {
        const msg = message as SDKResultMessage;
        if (msg.subtype === "success") {
          state.resultText = msg.result;
          state.status = "complete";
        } else {
          state.status = "failed";
          state.error = msg.errors.join("; ");
        }

        // Result usage is cumulative; overwrite totals rather than adding.
        state.totalInputTokens = msg.usage.input_tokens ?? 0;
        state.totalOutputTokens = msg.usage.output_tokens ?? 0;
        break;
      }
      // rate_limit_event: exposed for fallback routing (Task 3.7) to detect.
      // No action here; the error will propagate through the query iterator.
    }
  }
}
