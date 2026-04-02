import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { GenerateContentResponse } from "@google/genai";
import { GeminiAdapter } from "../src/agents/gemini-adapter.ts";
import type { GeminiAdapterDeps, GenAILike } from "../src/agents/gemini-adapter.ts";
import type { AgentInput } from "../src/agents/types.ts";

const SCHEMA_PATH = import.meta.dir + "/../src/db/schema.sql";

function freshDb(): Database {
  const db = new Database(":memory:");
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec("PRAGMA journal_mode=WAL");
  const statements = schema
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("PRAGMA"));
  for (const stmt of statements) {
    db.exec(stmt);
  }
  return db;
}

function makeTmpFiles(): { contractPath: string; systemPromptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gemini-adapter-test-"));
  const contractPath = join(dir, "contract.md");
  const systemPromptPath = join(dir, "system-prompt.md");
  writeFileSync(contractPath, "# Test Contract\nDo the thing.");
  writeFileSync(systemPromptPath, "You are a test agent.");
  return { contractPath, systemPromptPath };
}

function makeInput(overrides?: Partial<AgentInput>): AgentInput {
  const files = makeTmpFiles();
  return {
    taskId: "4.2",
    taskTitle: "Test Task",
    contractPath: files.contractPath,
    systemPromptPath: files.systemPromptPath,
    modelTier: "research",
    tools: [],
    budgetUsd: 5.0,
    ...overrides,
  };
}

/** Build a chunk with text and optional usage metadata. */
function makeChunk(opts: {
  text?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  functionCalls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
}): GenerateContentResponse {
  const chunk = {
    text: opts.text,
    usageMetadata: (opts.promptTokenCount != null || opts.candidatesTokenCount != null)
      ? {
          promptTokenCount: opts.promptTokenCount,
          candidatesTokenCount: opts.candidatesTokenCount,
        }
      : undefined,
    functionCalls: opts.functionCalls,
    candidates: [],
  } as unknown as GenerateContentResponse;
  return chunk;
}

/** Create a mock GenAI factory that yields given chunks. */
function mockGenAIFactory(chunks: GenerateContentResponse[]): (apiKey: string) => GenAILike {
  return (_apiKey: string): GenAILike => ({
    models: {
      async generateContentStream(_params: any) {
        async function* gen() {
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return gen();
      },
    },
  });
}

/** Create a mock GenAI factory that throws an error during streaming. */
function mockGenAIFactoryThrows(error: Error): (apiKey: string) => GenAILike {
  return (_apiKey: string): GenAILike => ({
    models: {
      async generateContentStream(_params: any) {
        async function* gen() {
          throw error;
        }
        return gen();
      },
    },
  });
}

/**
 * Create a mock GenAI factory for function calling.
 * First call yields function call chunks, subsequent calls yield text chunks.
 */
function mockGenAIFactoryWithFunctionCalls(
  functionCallChunks: GenerateContentResponse[],
  responseChunks: GenerateContentResponse[],
): (apiKey: string) => GenAILike {
  let callCount = 0;
  return (_apiKey: string): GenAILike => ({
    models: {
      async generateContentStream(_params: any) {
        const isFirstCall = callCount === 0;
        callCount++;
        const chunks = isFirstCall ? functionCallChunks : responseChunks;
        async function* gen() {
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return gen();
      },
    },
  });
}

describe("GeminiAdapter", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  describe("trigger", () => {
    it("returns a gemini- prefixed session ID", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([makeChunk({ text: "Hello" })]),
      });
      const sessionId = await adapter.trigger(makeInput());
      expect(sessionId).toMatch(/^gemini-/);
    });

    it("inserts a session record in the database", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([makeChunk({ text: "Hello" })]),
      });
      const sessionId = await adapter.trigger(makeInput());

      const row = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row).not.toBeNull();
      expect(row.agent).toBe("researcher");
      expect(row.provider).toBe("google");
      expect(row.model).toBe("gemini-3.1-pro-preview");
      expect(row.task_id).toBe("4.2");
    });

    it("uses correct model for research tier", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([makeChunk({ text: "ok" })]),
      });
      const sessionId = await adapter.trigger(makeInput({ modelTier: "research" }));
      const row = db.query("SELECT model FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row.model).toBe("gemini-3.1-pro-preview");
    });

    it("uses correct model for light tier", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([makeChunk({ text: "ok" })]),
      });
      const sessionId = await adapter.trigger(makeInput({ modelTier: "light" }));
      const row = db.query("SELECT model FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row.model).toBe("gemini-3.1-flash-lite-preview");
    });
  });

  describe("session lifecycle", () => {
    it("completes successfully with text response", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({ text: "Hello ", promptTokenCount: 10, candidatesTokenCount: 5 }),
          makeChunk({ text: "world!", promptTokenCount: 10, candidatesTokenCount: 12 }),
        ]),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const status = await adapter.status(sessionId);
      expect(status).toBe("complete");

      const output = await adapter.output(sessionId);
      expect(output.terminalState).toBe("complete");
      expect(output.error).toBeNull();
      expect(output.usage.inputTokens).toBe(10);
      expect(output.usage.outputTokens).toBe(12);
    });

    it("tracks cumulative token usage from streaming", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({ text: "A", promptTokenCount: 50, candidatesTokenCount: 10 }),
          makeChunk({ text: "B", promptTokenCount: 50, candidatesTokenCount: 25 }),
          makeChunk({ text: "C", promptTokenCount: 50, candidatesTokenCount: 40 }),
        ]),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const output = await adapter.output(sessionId);
      // Usage is cumulative — last chunk's values are final
      expect(output.usage.inputTokens).toBe(50);
      expect(output.usage.outputTokens).toBe(40);
    });

    it("logs cost to database", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({ text: "result", promptTokenCount: 1000, candidatesTokenCount: 500 }),
        ]),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const costRows = db.query("SELECT * FROM cost_log WHERE session_id = ?").all(sessionId) as any[];
      expect(costRows.length).toBeGreaterThan(0);
      expect(costRows[0].service).toBe("google/gemini-3.1-pro-preview");
      expect(costRows[0].amount_usd).toBeGreaterThan(0);
    });

    it("updates session record on completion", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({ text: "done", promptTokenCount: 100, candidatesTokenCount: 50 }),
        ]),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const row = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row.ended_at).not.toBeNull();
      expect(row.terminal_state).toBe("complete");
      expect(row.input_tokens).toBe(100);
      expect(row.output_tokens).toBe(50);
    });
  });

  describe("error handling", () => {
    it("sets failed status on stream error", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactoryThrows(new Error("API quota exceeded")),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const status = await adapter.status(sessionId);
      expect(status).toBe("failed");

      const output = await adapter.output(sessionId);
      expect(output.terminalState).toBe("failed");
      expect(output.error).toBe("API quota exceeded");
    });

    it("updates session record on error", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactoryThrows(new Error("Network error")),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      const row = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row.ended_at).not.toBeNull();
      expect(row.terminal_state).toBe("failed");
      expect(row.error).toBe("Network error");
    });
  });

  describe("cancel", () => {
    it("aborts and sets failed status", async () => {
      // Use a stream that never completes
      let resolveStream: () => void;
      const streamPromise = new Promise<void>((r) => { resolveStream = r; });
      const factory = (_apiKey: string): GenAILike => ({
        models: {
          async generateContentStream(_params: any) {
            async function* gen() {
              yield makeChunk({ text: "partial" });
              await streamPromise;
            }
            return gen();
          },
        },
      });

      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key", genaiFactory: factory });
      const sessionId = await adapter.trigger(makeInput());

      // Wait a tick for stream to start
      await new Promise((r) => setTimeout(r, 10));

      await adapter.cancel(sessionId);
      resolveStream!();

      const status = await adapter.status(sessionId);
      expect(status).toBe("failed");

      const row = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
      expect(row.terminal_state).toBe("failed");
      expect(row.error).toBe("Cancelled by user");
    });
  });

  describe("getLastActivityMs", () => {
    it("returns undefined for unknown session", () => {
      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key" });
      expect(adapter.getLastActivityMs("nonexistent")).toBeUndefined();
    });

    it("updates during streaming", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({ text: "chunk1" }),
          makeChunk({ text: "chunk2" }),
        ]),
      });
      const sessionId = await adapter.trigger(makeInput());
      // After trigger, lastActivityMs should be set
      const ms = adapter.getLastActivityMs(sessionId);
      expect(ms).toBeGreaterThan(0);

      await adapter.waitForCompletion(sessionId);
      const msAfter = adapter.getLastActivityMs(sessionId);
      expect(msAfter).toBeGreaterThanOrEqual(ms!);
    });
  });

  describe("waitForCompletion", () => {
    it("resolves after session completes", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([makeChunk({ text: "done" })]),
      });
      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);
      const status = await adapter.status(sessionId);
      expect(status).toBe("complete");
    });

    it("throws for unknown session", async () => {
      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key" });
      expect(adapter.waitForCompletion("nonexistent")).rejects.toThrow("Unknown session");
    });
  });

  describe("unknown session errors", () => {
    it("status throws for unknown session", async () => {
      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key" });
      expect(adapter.status("nonexistent")).rejects.toThrow("Unknown session");
    });

    it("output throws for unknown session", async () => {
      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key" });
      expect(adapter.output("nonexistent")).rejects.toThrow("Unknown session");
    });

    it("cancel throws for unknown session", async () => {
      const adapter = new GeminiAdapter({ db, geminiApiKey: "test-key" });
      expect(adapter.cancel("nonexistent")).rejects.toThrow("Unknown session");
    });
  });

  describe("function calling", () => {
    it("executes function calls and sends results back to model", async () => {
      const executedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const toolExecutor = async (name: string, args: Record<string, unknown>) => {
        executedCalls.push({ name, args });
        return { result: "tool output" };
      };

      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactoryWithFunctionCalls(
          // First call: model returns function call
          [makeChunk({
            functionCalls: [{ name: "search", args: { query: "test" }, id: "fc-1" }],
            promptTokenCount: 20,
            candidatesTokenCount: 10,
          })],
          // Second call: model returns final text
          [makeChunk({ text: "Final answer based on search results", promptTokenCount: 30, candidatesTokenCount: 20 })],
        ),
        toolExecutor,
      });

      const sessionId = await adapter.trigger(makeInput({
        tools: [JSON.stringify({ name: "search", parameters: { type: "object", properties: { query: { type: "string" } } } })],
      }));
      await adapter.waitForCompletion(sessionId);

      expect(executedCalls).toEqual([{ name: "search", args: { query: "test" } }]);

      const status = await adapter.status(sessionId);
      expect(status).toBe("complete");
    });

    it("skips function calls when no toolExecutor is provided", async () => {
      const adapter = new GeminiAdapter({
        db,
        geminiApiKey: "test-key",
        genaiFactory: mockGenAIFactory([
          makeChunk({
            functionCalls: [{ name: "search", args: { query: "test" } }],
            promptTokenCount: 20,
            candidatesTokenCount: 10,
          }),
        ]),
        // No toolExecutor
      });

      const sessionId = await adapter.trigger(makeInput());
      await adapter.waitForCompletion(sessionId);

      // Should still complete — just doesn't execute the function call
      const status = await adapter.status(sessionId);
      expect(status).toBe("complete");
    });
  });
});
