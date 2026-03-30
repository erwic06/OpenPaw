import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { LLMAdapter } from "../src/agents/llm-adapter.ts";
import type { LLMAdapterDeps } from "../src/agents/llm-adapter.ts";
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

/** Create a tmp dir with a fake contract and system prompt. */
function makeTmpFiles(): { contractPath: string; systemPromptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "llm-adapter-test-"));
  const contractPath = join(dir, "contract.md");
  const systemPromptPath = join(dir, "system-prompt.md");
  writeFileSync(contractPath, "# Test Contract\nDo the thing.");
  writeFileSync(systemPromptPath, "You are a test agent.");
  return { contractPath, systemPromptPath };
}

/** Build a fake SDKAssistantMessage with usage. */
function assistantMsg(inputTokens: number, outputTokens: number): SDKMessage {
  return {
    type: "assistant",
    uuid: "msg-1",
    session_id: "test",
    parent_tool_use_id: null,
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "working..." }],
      model: "claude-sonnet-4-6",
      stop_reason: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

/** Build a fake SDKResultMessage (success). */
function resultSuccess(
  resultText: string,
  inputTokens: number,
  outputTokens: number,
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: "result-1",
    session_id: "test",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    result: resultText,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

/** Build a fake SDKResultMessage (error). */
function resultError(errors: string[]): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    uuid: "result-1",
    session_id: "test",
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors,
  } as unknown as SDKMessage;
}

/** Create a mock queryFn that yields the given messages. */
function mockQueryFn(messages: SDKMessage[]) {
  return mock((_params: any) => {
    async function* gen() {
      for (const msg of messages) {
        yield msg;
      }
    }
    return gen() as any;
  });
}

/** Create a mock queryFn that throws. */
function mockQueryFnThrows(error: Error) {
  return mock((_params: any) => {
    async function* gen() {
      throw error;
    }
    return gen() as any;
  });
}

function makeInput(overrides?: Partial<AgentInput>): AgentInput {
  const files = makeTmpFiles();
  return {
    taskId: "3.5",
    taskTitle: "Test Task",
    contractPath: files.contractPath,
    systemPromptPath: files.systemPromptPath,
    modelTier: "standard",
    tools: [],
    budgetUsd: 5.0,
    ...overrides,
  };
}

let db: Database;
let deps: LLMAdapterDeps;

beforeEach(() => {
  db = freshDb();
  deps = {
    db,
    anthropicApiKey: "test-key",
  };
});

describe("LLMAdapter.trigger", () => {
  it("returns a session ID", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    expect(sessionId).toMatch(/^session-\d+-[a-z0-9]+$/);
  });

  it("inserts a session record in SQLite", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row).toBeDefined();
    expect(row.agent).toBe("coder");
    expect(row.task_id).toBe("3.5");
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.provider).toBe("anthropic");
  });

  it("maps modelTier to correct model", async () => {
    for (const [tier, expected] of [
      ["heavy", "claude-opus-4-6"],
      ["standard", "claude-sonnet-4-6"],
      ["light", "claude-haiku-4-5"],
    ] as const) {
      const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
      const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
      await adapter.trigger(makeInput({ modelTier: tier }));
      const params = qfn.mock.calls[0][0];
      expect(params.options.model).toBe(expected);
    }
  });

  it("passes permissionMode bypassPermissions", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    await adapter.trigger(makeInput());
    const params = qfn.mock.calls[0][0];
    expect(params.options.permissionMode).toBe("bypassPermissions");
    expect(params.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("passes API key via env, not process.env", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    await adapter.trigger(makeInput());
    const params = qfn.mock.calls[0][0];
    expect(params.options.env.ANTHROPIC_API_KEY).toBe("test-key");
  });

  it("reads system prompt from file path", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    await adapter.trigger(makeInput());
    const params = qfn.mock.calls[0][0];
    expect(params.options.systemPrompt).toBe("You are a test agent.");
  });

  it("handles null systemPromptPath", async () => {
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    await adapter.trigger(makeInput({ systemPromptPath: null }));
    const params = qfn.mock.calls[0][0];
    expect(params.options.systemPrompt).toBeUndefined();
  });

  it("passes mcpServers from deps", async () => {
    const mcpServers = { "daytona-tools": {} as any };
    const qfn = mockQueryFn([resultSuccess("done", 100, 50)]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn, mcpServers });
    await adapter.trigger(makeInput());
    const params = qfn.mock.calls[0][0];
    expect(params.options.mcpServers).toBe(mcpServers);
  });
});

describe("LLMAdapter.status", () => {
  it("returns running immediately after trigger", async () => {
    // Use a query that won't resolve immediately
    const qfn = mock((_params: any) => {
      async function* gen() {
        await new Promise((r) => setTimeout(r, 500));
        yield resultSuccess("done", 100, 50);
      }
      return gen() as any;
    });
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    const status = await adapter.status(sessionId);
    expect(status).toBe("running");
  });

  it("returns complete after session finishes", async () => {
    const qfn = mockQueryFn([
      assistantMsg(100, 50),
      resultSuccess("all done", 100, 50),
    ]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    // Wait for background session to complete
    await new Promise((r) => setTimeout(r, 100));
    const status = await adapter.status(sessionId);
    expect(status).toBe("complete");
  });

  it("throws for unknown session", async () => {
    const adapter = new LLMAdapter(deps);
    expect(adapter.status("nonexistent")).rejects.toThrow("Unknown session");
  });
});

describe("LLMAdapter.output", () => {
  it("returns usage and cost after completion", async () => {
    const qfn = mockQueryFn([
      assistantMsg(200, 100),
      resultSuccess("task complete", 200, 100),
    ]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const output = await adapter.output(sessionId);
    expect(output.sessionId).toBe(sessionId);
    expect(output.terminalState).toBe("complete");
    expect(output.usage.inputTokens).toBe(200);
    expect(output.usage.outputTokens).toBe(100);
    expect(output.costUsd).toBeGreaterThan(0);
    expect(output.error).toBeNull();
  });

  it("returns failed state on error result", async () => {
    const qfn = mockQueryFn([resultError(["something broke"])]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toContain("something broke");
  });

  it("returns failed state when query throws", async () => {
    const qfn = mockQueryFnThrows(new Error("API connection failed"));
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toBe("API connection failed");
  });
});

describe("LLMAdapter.cancel", () => {
  it("aborts the running session", async () => {
    const qfn = mock((_params: any) => {
      async function* gen() {
        await new Promise((r) => setTimeout(r, 5000));
        yield resultSuccess("should not reach", 0, 0);
      }
      return gen() as any;
    });
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());

    await adapter.cancel(sessionId);

    const status = await adapter.status(sessionId);
    expect(status).toBe("failed");
    const output = await adapter.output(sessionId);
    expect(output.error).toBe("Cancelled by user");
  });

  it("updates SQLite session record on cancel", async () => {
    const qfn = mock((_params: any) => {
      async function* gen() {
        await new Promise((r) => setTimeout(r, 5000));
        yield resultSuccess("nope", 0, 0);
      }
      return gen() as any;
    });
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.cancel(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.terminal_state).toBe("failed");
    expect(row.error).toBe("Cancelled by user");
    expect(row.ended_at).toBeDefined();
  });
});

describe("LLMAdapter.getLastActivityMs", () => {
  it("returns undefined for unknown session", () => {
    const adapter = new LLMAdapter(deps);
    expect(adapter.getLastActivityMs("nope")).toBeUndefined();
  });

  it("updates on each message", async () => {
    const qfn = mockQueryFn([
      assistantMsg(100, 50),
      resultSuccess("done", 100, 50),
    ]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const ts = adapter.getLastActivityMs(sessionId);
    expect(ts).toBeDefined();
    expect(ts!).toBeGreaterThan(0);
  });
});

describe("cost tracking integration", () => {
  it("logs usage to cost_log for assistant messages", async () => {
    const qfn = mockQueryFn([
      assistantMsg(500, 200),
      resultSuccess("done", 500, 200),
    ]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const rows = db.prepare("SELECT * FROM cost_log WHERE session_id = ?").all(sessionId) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].service).toBe("anthropic/claude-sonnet-4-6");
    expect(rows[0].amount_usd).toBeGreaterThan(0);
  });

  it("updates session record with final token counts", async () => {
    const qfn = mockQueryFn([
      assistantMsg(300, 150),
      resultSuccess("done", 300, 150),
    ]);
    const adapter = new LLMAdapter({ ...deps, queryFn: qfn });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.terminal_state).toBe("complete");
    expect(row.input_tokens).toBe(300);
    expect(row.output_tokens).toBe(150);
    expect(row.cost_usd).toBeGreaterThan(0);
  });
});
