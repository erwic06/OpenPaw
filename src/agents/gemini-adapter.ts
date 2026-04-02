import type { Database } from "bun:sqlite";
import {
  GoogleGenAI,
  type GenerateContentResponse,
  type Content,
  type Part,
  type FunctionDeclaration,
} from "@google/genai";
import type { AgentAdapter, AgentInput, AgentOutput, AgentStatus } from "./types.ts";
import { logUsage, getSessionCost } from "../costs/index.ts";
import { insertSession, updateSession } from "../db/index.ts";

/** Minimal interface matching the GoogleGenAI SDK methods we use. */
export interface GenAILike {
  models: {
    generateContentStream(
      params: {
        model: string;
        contents: Content[];
        config?: {
          systemInstruction?: string;
          tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>;
          abortSignal?: AbortSignal;
        };
      },
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

/** Injected dependencies for testability. */
export interface GeminiAdapterDeps {
  db: Database;
  geminiApiKey: string;
  /** Working directory for file-based context. */
  cwd?: string;
  /** Override GenAI client factory for testing. */
  genaiFactory?: (apiKey: string) => GenAILike;
  /** Tool executor for function calling. Called when model returns a function call. */
  toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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

const MODEL_MAP: Record<string, string> = {
  research: "gemini-3.1-pro-preview",
  standard: "gemini-3.1-pro-preview",
  light: "gemini-3.1-flash-lite-preview",
};

function generateSessionId(): string {
  return `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class GeminiAdapter implements AgentAdapter {
  private deps: GeminiAdapterDeps;
  private sessions = new Map<string, SessionState>();

  constructor(deps: GeminiAdapterDeps) {
    this.deps = deps;
  }

  async trigger(input: AgentInput): Promise<string> {
    const sessionId = generateSessionId();
    const controller = new AbortController();
    const model = MODEL_MAP[input.modelTier] ?? "gemini-3.1-pro-preview";
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
      agent: "researcher",
      task_id: input.taskId,
      model,
      provider: "google",
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
      tools: input.tools,
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
      systemPrompt: string | undefined;
      model: string;
      controller: AbortController;
      tools: string[];
    },
  ): Promise<void> {
    try {
      const client = this.createClient();
      const contents: Content[] = [
        { role: "user", parts: [{ text: opts.prompt }] },
      ];

      // Build tool declarations if provided (string[] of JSON-encoded FunctionDeclaration[])
      const toolDeclarations = opts.tools.length > 0
        ? [{ functionDeclarations: opts.tools.map((t) => JSON.parse(t) as FunctionDeclaration) }]
        : undefined;

      // Streaming loop with function calling support
      let continueLoop = true;
      while (continueLoop) {
        continueLoop = false;

        const stream = await client.models.generateContentStream({
          model: opts.model,
          contents,
          config: {
            systemInstruction: opts.systemPrompt,
            tools: toolDeclarations,
            abortSignal: opts.controller.signal,
          },
        });

        let lastChunkText = "";
        const functionCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];

        for await (const chunk of stream) {
          if (opts.controller.signal.aborted) break;
          state.lastActivityMs = Date.now();

          // Accumulate text
          if (chunk.text) {
            lastChunkText += chunk.text;
          }

          // Collect function calls
          if (chunk.functionCalls) {
            for (const fc of chunk.functionCalls) {
              if (fc.name) {
                functionCalls.push({ name: fc.name, args: fc.args ?? {}, id: fc.id });
              }
            }
          }

          // Track usage from each chunk
          const usage = chunk.usageMetadata;
          if (usage) {
            const inputTokens = usage.promptTokenCount ?? 0;
            const outputTokens = usage.candidatesTokenCount ?? 0;
            // Usage metadata is cumulative per stream — overwrite totals
            state.totalInputTokens = inputTokens;
            state.totalOutputTokens = outputTokens;
          }
        }

        if (opts.controller.signal.aborted) break;

        // Log usage for this turn
        if (state.totalInputTokens > 0 || state.totalOutputTokens > 0) {
          logUsage(
            { db: this.deps.db },
            sessionId,
            state.model,
            "google",
            state.totalInputTokens,
            state.totalOutputTokens,
          );
        }

        state.resultText = lastChunkText;

        // Handle function calls if present and executor provided
        if (functionCalls.length > 0 && this.deps.toolExecutor) {
          // Add assistant's response (with function calls) to conversation
          const assistantParts: Part[] = functionCalls.map((fc) => ({
            functionCall: { name: fc.name, args: fc.args, id: fc.id },
          }));
          contents.push({ role: "model", parts: assistantParts });

          // Execute each function and build response parts
          const responseParts: Part[] = [];
          for (const fc of functionCalls) {
            const result = await this.deps.toolExecutor(fc.name, fc.args);
            responseParts.push({
              functionResponse: {
                name: fc.name,
                id: fc.id,
                response: { output: result },
              },
            });
          }
          contents.push({ role: "user", parts: responseParts });

          // Continue the conversation
          continueLoop = true;
        }
      }

      if (opts.controller.signal.aborted) return;

      state.status = "complete";
      updateSession(this.deps.db, sessionId, {
        ended_at: new Date().toISOString(),
        terminal_state: "complete",
        input_tokens: state.totalInputTokens,
        output_tokens: state.totalOutputTokens,
        cost_usd: getSessionCost({ db: this.deps.db }, sessionId),
        error: null,
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

  private createClient(): GenAILike {
    if (this.deps.genaiFactory) {
      return this.deps.genaiFactory(this.deps.geminiApiKey);
    }
    return new GoogleGenAI({ apiKey: this.deps.geminiApiKey });
  }
}
