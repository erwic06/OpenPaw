import type { Database } from "bun:sqlite";
import type { AgentAdapter, AgentInput, AgentOutput, AgentStatus } from "./types.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";
import { insertSession, updateSession } from "../db/index.ts";

/** OpenAI function-calling tool definition. */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Executes a tool by name and returns the string result. */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/** Minimal chat completion request shape for DI. */
export interface ChatCreateParams {
  model: string;
  messages: ChatMessage[];
  tools?: OpenAIToolDef[];
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCreateResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface OpenAIAdapterDeps {
  db: Database;
  openaiApiKey: string;
  tools?: OpenAIToolDef[];
  toolExecutor?: ToolExecutor;
  /** Override chat completion for testing. */
  chatCreate?: (params: ChatCreateParams) => Promise<ChatCreateResponse>;
}

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
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MODEL_MAP: Record<string, string> = {
  heavy: "gpt-5.4-high",
  standard: "gpt-5.4-medium",
  light: "gpt-5.4-mini",
};

export class OpenAIAdapter implements AgentAdapter {
  private deps: OpenAIAdapterDeps;
  private sessions = new Map<string, SessionState>();

  constructor(deps: OpenAIAdapterDeps) {
    this.deps = deps;
  }

  async trigger(input: AgentInput): Promise<string> {
    const sessionId = generateSessionId();
    const controller = new AbortController();
    const model = MODEL_MAP[input.modelTier] ?? "gpt-5.4-medium";
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
    const prompt = `Execute task ${input.taskId}: ${input.taskTitle}\n\n${contractContent}`;

    state.runPromise = this.runSession(sessionId, state, {
      prompt,
      systemPrompt,
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
    },
  ): Promise<void> {
    try {
      const chatCreate = this.deps.chatCreate ?? this.makeDefaultChatCreate();
      const messages: ChatMessage[] = [];

      if (opts.systemPrompt) {
        messages.push({ role: "system", content: opts.systemPrompt });
      }
      messages.push({ role: "user", content: opts.prompt });

      let done = false;
      while (!done && !opts.controller.signal.aborted) {
        const response = await chatCreate({
          model: opts.model,
          messages,
          tools: this.deps.tools?.length ? this.deps.tools : undefined,
        });

        state.lastActivityMs = Date.now();

        const choice = response.choices[0];
        if (!choice) {
          state.status = "failed";
          state.error = "No response from OpenAI";
          done = true;
          break;
        }

        const usage = response.usage;
        if (usage) {
          state.totalInputTokens += usage.prompt_tokens;
          state.totalOutputTokens += usage.completion_tokens;

          if (usage.prompt_tokens > 0 || usage.completion_tokens > 0) {
            logUsage(
              { db: this.deps.db },
              sessionId,
              state.model,
              "openai",
              usage.prompt_tokens,
              usage.completion_tokens,
            );
          }
        }

        const assistantMessage = choice.message;
        messages.push({
          role: "assistant",
          content: assistantMessage.content,
          tool_calls: assistantMessage.tool_calls,
        });

        if (assistantMessage.tool_calls?.length && this.deps.toolExecutor) {
          for (const toolCall of assistantMessage.tool_calls) {
            if (opts.controller.signal.aborted) break;

            let args: Record<string, unknown>;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch {
              args = {};
            }

            let result: string;
            try {
              result = await this.deps.toolExecutor(toolCall.function.name, args);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result,
            });
            state.lastActivityMs = Date.now();
          }
        } else {
          // No tool calls -- session complete
          state.resultText = assistantMessage.content ?? "";
          state.status = "complete";
          done = true;
        }
      }

      if (opts.controller.signal.aborted) return;

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

  private makeDefaultChatCreate(): (params: ChatCreateParams) => Promise<ChatCreateResponse> {
    const { default: OpenAI } = require("openai");
    const client = new OpenAI({ apiKey: this.deps.openaiApiKey });
    return async (params) => {
      return client.chat.completions.create(params as any) as unknown as ChatCreateResponse;
    };
  }
}
