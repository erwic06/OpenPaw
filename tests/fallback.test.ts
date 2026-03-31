import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AgentOutput } from "../src/agents/types.ts";
import { executeWithFallback, isRetryableError } from "../src/agents/fallback.ts";
import type { FallbackDeps } from "../src/agents/fallback.ts";

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
      "gpt-5.4",
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
      "gpt-5.4",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).not.toHaveBeenCalled();
    expect(sleepCalls).toEqual([30_000, 60_000]);
    expect(alertMessages).toHaveLength(0);
  });

  it("uses exponential backoff delays (30s, 60s, 120s)", async () => {
    const primary = mock(async () => {
      throw new Error("rate limit exceeded");
    });
    const fallback = mock(async () => successOutput("fb"));

    await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4",
      primary,
      fallback,
      deps,
    );

    expect(sleepCalls.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
  });

  it("activates fallback after 3 failed retries and sends Telegram alert", async () => {
    const primary = mock(async () => {
      throw new Error("rate limit exceeded");
    });
    const fallback = mock(async () => successOutput("fb-session"));

    const result = await executeWithFallback(
      "claude-sonnet-4-6",
      "gpt-5.4",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(result.sessionId).toBe("fb-session");
    expect(primary).toHaveBeenCalledTimes(4);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("Fallback activated");
    expect(alertMessages[0]).toContain("claude-sonnet-4-6");
    expect(alertMessages[0]).toContain("gpt-5.4");
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
      "gpt-5.4",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("failed");
    expect(result.error).toContain("All providers exhausted");
    expect(result.error).toContain("claude-sonnet-4-6");
    expect(result.error).toContain("gpt-5.4");
    expect(primary).toHaveBeenCalledTimes(4);
    expect(fallback).toHaveBeenCalledTimes(4);
    expect(alertMessages).toHaveLength(1);
  });

  it("propagates non-retryable errors immediately without retry", async () => {
    const primary = mock(async () => {
      throw new Error("invalid API key");
    });
    const fallback = mock(async () => successOutput("fb"));

    await expect(
      executeWithFallback(
        "claude-sonnet-4-6",
        "gpt-5.4",
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
      "gpt-5.4",
      primary,
      fallback,
      deps,
    );

    expect(result.terminalState).toBe("complete");
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toHaveLength(4);
  });
});
