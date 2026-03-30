import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentOutput } from "../src/agents/types.ts";
import type { AgentInput } from "../src/agents/types.ts";
import { executeWithFallback, isRetryableError } from "../src/agents/fallback.ts";
import type { FallbackDeps } from "../src/agents/fallback.ts";
import { OpenAIAdapter } from "../src/agents/openai-adapter.ts";
import type { OpenAIAdapterDeps, ChatCreateResponse } from "../src/agents/openai-adapter.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "fallback-test-"));
  const contractPath = join(dir, "contract.md");
  const systemPromptPath = join(dir, "system-prompt.md");
  writeFileSync(contractPath, "# Test Contract\nDo the thing.");
  writeFileSync(systemPromptPath, "You are a test agent.");
  return { contractPath, systemPromptPath };
}

function successOutput(sessionId = "test-session"): AgentOutput {
  return {
    sessionId,
    terminalState: "complete",
    artifacts: ["file.ts"],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.01,
    error: null,
  };
}

// --- isRetryableError ---

describe("isRetryableError", () => {
  it("detects rate limit errors", () => {
    expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("detects quota errors", () => {
    expect(isRetryableError(new Error("quota exceeded"))).toBe(true);
  });

  it("detects overload/503 errors", () => {
    expect(isRetryableError(new Error("service overloaded"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 503"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 529"))).toBe(true);
  });

  it("detects connection errors", () => {
    expect(isRetryableError(new Error("connection refused"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("request timeout"))).toBe(true);
  });

  it("rejects non-retryable errors", () => {
    expect(isRetryableError(new Error("invalid API key"))).toBe(false);
    expect(isRetryableError(new Error("permission denied"))).toBe(false);
    expect(isRetryableError(new Error("model not found"))).toBe(false);
  });

  it("rejects non-Error values", () => {
    expect(isRetryableError("rate limit")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(429)).toBe(false);
  });
});

// --- executeWithFallback ---

describe("executeWithFallback", () => {
  let sleepCalls: number[];
  let alertMessages: string[];
  let deps: FallbackDeps;

  beforeEach(() => {
    sleepCalls = [];
    alertMessages = [];
    deps = {
      sendAlert: mock(async (msg: string) => {
        alertMessages.push(msg);
      }),
      sleep: mock(async (ms: number) => {
        sleepCalls.push(ms);
      }),
    };
  });

  it("returns primary result on first success", async () => {
    const primary = mock(async () => successOutput());
    const fallback = mock(async () => successOutput("fb"));

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(alertMessages).toHaveLength(0);
    expect(sleepCalls).toHaveLength(0);
  });

  it("retries on retryable error then succeeds", async () => {
    let attempt = 0;
    const primary = mock(async () => {
      attempt++;
      if (attempt < 3) throw new Error("rate limit exceeded");
      return successOutput();
    });
    const fallback = mock(async () => successOutput("fb"));

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(primary).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(fallback).not.toHaveBeenCalled();
    expect(sleepCalls).toEqual([30_000, 60_000]); // 2 backoff sleeps
    expect(alertMessages).toHaveLength(0);
  });

  it("uses exponential backoff delays (30s, 60s, 120s)", async () => {
    const primary = mock(async () => {
      throw new Error("rate limit exceeded");
    });
    const fallback = mock(async () => successOutput("fb"));

    await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    // 3 retry sleeps for primary (initial + 3 retries = 4 attempts, 3 sleeps)
    // Then fallback succeeds on first attempt
    expect(sleepCalls.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
  });

  it("activates fallback after 3 failed retries and sends Telegram alert", async () => {
    const primary = mock(async () => {
      throw new Error("rate limit exceeded");
    });
    const fallback = mock(async () => successOutput("fb-session"));

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(result.sessionId).toBe("fb-session");
    expect(primary).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("Fallback activated");
    expect(alertMessages[0]).toContain("claude-sonnet-4-6");
    expect(alertMessages[0]).toContain("gpt-5.4-medium");
  });

  it("returns failed output when all providers are exhausted", async () => {
    const primary = mock(async () => {
      throw new Error("rate limit exceeded");
    });
    const fallback = mock(async () => {
      throw new Error("quota exceeded");
    });

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("failed");
    expect(result.error).toContain("All providers exhausted");
    expect(result.error).toContain("claude-sonnet-4-6");
    expect(result.error).toContain("gpt-5.4-medium");
    expect(primary).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(fallback).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(alertMessages).toHaveLength(1); // only one alert for fallback activation
  });

  it("propagates non-retryable errors immediately without retry", async () => {
    const primary = mock(async () => {
      throw new Error("invalid API key");
    });
    const fallback = mock(async () => successOutput("fb"));

    await expect(
      executeWithFallback(
        "claude-sonnet-4-6",
        "gpt-5.4-medium",
        primary,
        fallback,
        deps,
      ),
    ).rejects.toThrow("invalid API key");

    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(sleepCalls).toHaveLength(0);
  });

  it("retries fallback with backoff too", async () => {
    const primary = mock(async () => {
      throw new Error("connection timeout");
    });
    let fbAttempt = 0;
    const fallback = mock(async () => {
      fbAttempt++;
      if (fbAttempt < 2) throw new Error("HTTP 503");
      return successOutput("fb-session");
    });

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4-medium",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(fallback).toHaveBeenCalledTimes(2);
    // 3 sleeps for primary retries + 1 sleep for fallback retry
    expect(sleepCalls).toHaveLength(4);
  });
});

// --- OpenAIAdapter ---

describe("OpenAIAdapter", () => {
  let db: Database;

  function makeInput(overrides?: Partial<AgentInput>): AgentInput {
    const files = makeTmpFiles();
    return {
      taskId: "3.7",
      taskTitle: "Test Task",
      contractPath: files.contractPath,
      systemPromptPath: files.systemPromptPath,
      modelTier: "standard",
      tools: [],
      budgetUsd: 5.0,
      ...overrides,
    };
  }

  function simpleResponse(content: string): ChatCreateResponse {
    return {
      choices: [{
        message: { role: "assistant", content, tool_calls: undefined },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
  }

  function toolCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): ChatCreateResponse {
    return {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: `call-${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    };
  }

  beforeEach(() => {
    db = freshDb();
  });

  it("returns a session ID", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    expect(sessionId).toMatch(/^session-\d+-[a-z0-9]+$/);
  });

  it("inserts session record with openai provider", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-5.4-medium");
  });

  it("maps modelTier to correct OpenAI model", async () => {
    for (const [tier, expected] of [
      ["heavy", "gpt-5.4-high"],
      ["standard", "gpt-5.4-medium"],
      ["light", "gpt-5.4-mini"],
    ] as const) {
      const chatCreate = mock(async () => simpleResponse("done"));
      const adapter = new OpenAIAdapter({ db: freshDb(), openaiApiKey: "test-key", chatCreate });
      await adapter.trigger(makeInput({ modelTier: tier }));
      const params = chatCreate.mock.calls[0][0];
      expect(params.model).toBe(expected);
    }
  });

  it("completes session and updates SQLite", async () => {
    const chatCreate = mock(async () => simpleResponse("task done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const status = await adapter.status(sessionId);
    expect(status).toBe("complete");

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("complete");
    expect(output.usage.inputTokens).toBe(100);
    expect(output.usage.outputTokens).toBe(50);
    expect(output.costUsd).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.terminal_state).toBe("complete");
  });

  it("executes tool calls and loops", async () => {
    let callCount = 0;
    const chatCreate = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ name: "shell_exec", args: { command: "ls" } }]);
      }
      return simpleResponse("done with tools");
    });

    const toolExecutor = mock(async (name: string, _args: Record<string, unknown>) => {
      return `result of ${name}`;
    });

    const adapter = new OpenAIAdapter({
      db,
      openaiApiKey: "test-key",
      chatCreate,
      tools: [{
        type: "function",
        function: { name: "shell_exec", description: "Run a command", parameters: {} },
      }],
      toolExecutor,
    });

    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor.mock.calls[0][0]).toBe("shell_exec");

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("complete");
    expect(chatCreate).toHaveBeenCalledTimes(2);
  });

  it("handles tool execution errors gracefully", async () => {
    let callCount = 0;
    const chatCreate = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ name: "file_read", args: { path: "/missing" } }]);
      }
      return simpleResponse("handled error");
    });

    const toolExecutor = mock(async () => {
      throw new Error("file not found");
    });

    const adapter = new OpenAIAdapter({
      db,
      openaiApiKey: "test-key",
      chatCreate,
      tools: [{
        type: "function",
        function: { name: "file_read", description: "Read a file", parameters: {} },
      }],
      toolExecutor,
    });

    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("complete");

    // Check that the error message was sent back as tool result
    const lastCall = chatCreate.mock.calls[1][0];
    const toolMsg = lastCall.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("Error: file not found");
  });

  it("logs usage to cost_log", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const rows = db.prepare("SELECT * FROM cost_log WHERE session_id = ?").all(sessionId) as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].service).toBe("openai/gpt-5.4-medium");
  });

  it("handles API errors by marking session failed", async () => {
    const chatCreate = mock(async () => {
      throw new Error("invalid API key");
    });
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "bad-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const output = await adapter.output(sessionId);
    expect(output.terminalState).toBe("failed");
    expect(output.error).toBe("invalid API key");
  });

  it("cancel aborts session", async () => {
    const chatCreate = mock(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return simpleResponse("nope");
    });
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    await adapter.cancel(sessionId);

    const status = await adapter.status(sessionId);
    expect(status).toBe("failed");
    const output = await adapter.output(sessionId);
    expect(output.error).toBe("Cancelled by user");
  });

  it("getLastActivityMs returns timestamp", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    const sessionId = await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 100));

    const ts = adapter.getLastActivityMs(sessionId);
    expect(ts).toBeDefined();
    expect(ts!).toBeGreaterThan(0);
  });

  it("passes system prompt in messages", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    await adapter.trigger(makeInput());
    await new Promise((r) => setTimeout(r, 50));

    const params = chatCreate.mock.calls[0][0];
    expect(params.messages[0]).toEqual({ role: "system", content: "You are a test agent." });
  });

  it("handles null systemPromptPath", async () => {
    const chatCreate = mock(async () => simpleResponse("done"));
    const adapter = new OpenAIAdapter({ db, openaiApiKey: "test-key", chatCreate });
    await adapter.trigger(makeInput({ systemPromptPath: null }));
    await new Promise((r) => setTimeout(r, 50));

    const params = chatCreate.mock.calls[0][0];
    expect(params.messages[0].role).toBe("user");
  });
});
