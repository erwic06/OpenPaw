import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexAdapter } from "../src/agents/codex-adapter.ts";
import type { CodexAdapterDeps, CodexLike, ThreadLike } from "../src/agents/codex-adapter.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "codex-adapter-test-"));
  const contractPath = join(dir, "contract.md");
  const systemPromptPath = join(dir, "system-prompt.md");
  writeFileSync(contractPath, "# Test Contract\nDo the thing.");
  writeFileSync(systemPromptPath, "You are a test agent.");
  return { contractPath, systemPromptPath };
}

function makeInput(overrides?: Partial<AgentInput>): AgentInput {
  const files = makeTmpFiles();
  return {
    taskId: "3.5",
    taskTitle: "Test Task",
    contractPath: files.contractPath,
    systemPromptPath: files.systemPromptPath,
    modelTier: "light",
    tools: [],
    budgetUsd: 5.0,
    ...overrides,
  };
}

/** Create a mock Codex factory that yields given events. */
function mockCodexFactory(events: ThreadEvent[]): (apiKey: string) => CodexLike {
  return (_apiKey: string): CodexLike => ({
    startThread: (_options?: any): ThreadLike => ({
      async runStreamed(_input: string, _opts?: any) {
        async function* gen() {
          for (const event of events) {
            yield event;
          }
        }
        return { events: gen() };
      },
    }),
  });
}

/** Create a mock Codex factory that throws. */
function mockCodexFactoryThrows(error: Error): (apiKey: string) => CodexLike {
  return (_apiKey: string): CodexLike => ({
    startThread: (_options?: any): ThreadLike => ({
      async runStreamed(_input: string, _opts?: any) {
        async function* gen() {
          throw error;
        }
        return { events: gen() };
      },
    }),
  });
}

function turnCompleted(inputTokens: number, outputTokens: number): ThreadEvent {
  return {
    type: "turn.completed",
    usage: { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: outputTokens },
  } as ThreadEvent;
}

function turnFailed(message: string): ThreadEvent {
  return {
    type: "turn.failed",
    error: { message },
  } as ThreadEvent;
}

function agentMessage(text: string): ThreadEvent {
  return {
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text },
  } as ThreadEvent;
}

function errorEvent(message: string): ThreadEvent {
  return {
    type: "error",
    message,
  } as ThreadEvent;
}

let db: Database;
let deps: CodexAdapterDeps;

beforeEach(() => {
  db = freshDb();
  deps = {
    db,
    openaiApiKey: "test-key",
  };
});

describe("CodexAdapter.trigger", () => {
  it("returns a session ID", async () => {
    const factory = mockCodexFactory([turnCompleted(100, 50)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    expect(sessionId).toMatch(/^codex-\d+-[a-z0-9]+$/);
  });

  it("inserts a session record in SQLite", async () => {
    const factory = mockCodexFactory([turnCompleted(100, 50)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row).toBeDefined();
    expect(row.agent).toBe("coder");
    expect(row.task_id).toBe("3.5");
    expect(row.provider).toBe("openai");
  });

  it("maps light tier to gpt-5.4-mini", async () => {
    const factory = mockCodexFactory([turnCompleted(100, 50)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput({ modelTier: "light" }));
    await adapter.waitForCompletion(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.model).toBe("gpt-5.4-mini");
  });

  it("maps standard tier to gpt-5.4", async () => {
    const factory = mockCodexFactory([turnCompleted(100, 50)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput({ modelTier: "standard" }));
    await adapter.waitForCompletion(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.model).toBe("gpt-5.4");
  });
});

describe("CodexAdapter.status", () => {
  it("returns running immediately after trigger", async () => {
    const factory = (_key: string): CodexLike => ({
      startThread: (_opts?: any): ThreadLike => ({
        async runStreamed(_input: string, _opts?: any) {
          async function* gen() {
            await new Promise((r) => setTimeout(r, 500));
            yield turnCompleted(100, 50);
          }
          return { events: gen() };
        },
      }),
    });
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    const status = await adapter.status(sessionId);
    expect(status).toBe("running");
  });

  it("returns complete after session finishes", async () => {
    const factory = mockCodexFactory([
      agentMessage("done"),
      turnCompleted(100, 50),
    ]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const status = await adapter.status(sessionId);
    expect(status).toBe("complete");
  });

  it("throws for unknown session", async () => {
    const adapter = new CodexAdapter(deps);
    expect(adapter.status("nonexistent")).rejects.toThrow("Unknown session");
  });
});

describe("CodexAdapter.output", () => {
  it("returns usage after completion", async () => {
    const factory = mockCodexFactory([
      agentMessage("task complete"),
      turnCompleted(200, 100),
    ]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const output = await adapter.output(sessionId);
    expect(output.sessionId).toBe(sessionId);
    expect(output.terminalState).toBe("complete");
    expect(output.usage.inputTokens).toBe(200);
    expect(output.usage.outputTokens).toBe(100);
    expect(output.error).toBeNull();
  });

  it("returns failed state on turn failure", async () => {
    const factory = mockCodexFactory([turnFailed("model error")]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toContain("model error");
  });

  it("returns failed state on error event", async () => {
    const factory = mockCodexFactory([errorEvent("stream error")]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toBe("stream error");
  });

  it("returns failed state when runStreamed throws", async () => {
    const factory = mockCodexFactoryThrows(new Error("connection refused"));
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toBe("connection refused");
  });
});

describe("CodexAdapter.cancel", () => {
  it("aborts the running session", async () => {
    const factory = (_key: string): CodexLike => ({
      startThread: (_opts?: any): ThreadLike => ({
        async runStreamed(_input: string, _opts?: any) {
          async function* gen() {
            await new Promise((r) => setTimeout(r, 5000));
            yield turnCompleted(0, 0);
          }
          return { events: gen() };
        },
      }),
    });
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());

    await adapter.cancel(sessionId);

    const status = await adapter.status(sessionId);
    expect(status).toBe("failed");
    const output = await adapter.output(sessionId);
    expect(output.error).toBe("Cancelled by user");
  });

  it("updates SQLite on cancel", async () => {
    const factory = (_key: string): CodexLike => ({
      startThread: (_opts?: any): ThreadLike => ({
        async runStreamed(_input: string, _opts?: any) {
          async function* gen() {
            await new Promise((r) => setTimeout(r, 5000));
            yield turnCompleted(0, 0);
          }
          return { events: gen() };
        },
      }),
    });
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.cancel(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.terminal_state).toBe("failed");
    expect(row.error).toBe("Cancelled by user");
  });
});

describe("CodexAdapter.getLastActivityMs", () => {
  it("returns undefined for unknown session", () => {
    const adapter = new CodexAdapter(deps);
    expect(adapter.getLastActivityMs("nope")).toBeUndefined();
  });

  it("updates on events", async () => {
    const factory = mockCodexFactory([
      agentMessage("working"),
      turnCompleted(100, 50),
    ]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const ts = adapter.getLastActivityMs(sessionId);
    expect(ts).toBeDefined();
    expect(ts!).toBeGreaterThan(0);
  });
});

describe("cost tracking", () => {
  it("logs usage to cost_log on turn completion", async () => {
    const factory = mockCodexFactory([turnCompleted(500, 200)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const rows = db.prepare("SELECT * FROM cost_log WHERE session_id = ?").all(sessionId) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].service).toBe("openai/gpt-5.4-mini");
  });

  it("updates session record with final token counts", async () => {
    const factory = mockCodexFactory([turnCompleted(300, 150)]);
    const adapter = new CodexAdapter({ ...deps, codexFactory: factory });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.waitForCompletion(sessionId);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.terminal_state).toBe("complete");
    expect(row.input_tokens).toBe(300);
    expect(row.output_tokens).toBe(150);
  });
});
