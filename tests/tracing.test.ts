import { describe, test, expect } from "bun:test";
import { scrubSecrets } from "../src/tracing/sanitize.ts";
import {
  initTracing,
  traceSession,
  shutdownTracing,
  isTracingInitialized,
} from "../src/tracing/index.ts";

// --- scrubSecrets ---

describe("scrubSecrets", () => {
  test("replaces a secret value with [REDACTED]", () => {
    const secrets = new Set(["sk-abc123xyz"]);
    expect(scrubSecrets("key is sk-abc123xyz", secrets)).toBe(
      "key is [REDACTED]",
    );
  });

  test("replaces multiple secrets", () => {
    const secrets = new Set(["secret1234", "token5678"]);
    const result = scrubSecrets(
      "a=secret1234 b=token5678",
      secrets,
    );
    expect(result).toBe("a=[REDACTED] b=[REDACTED]");
  });

  test("replaces all occurrences of the same secret", () => {
    const secrets = new Set(["mykey123"]);
    expect(scrubSecrets("mykey123 and mykey123", secrets)).toBe(
      "[REDACTED] and [REDACTED]",
    );
  });

  test("skips secrets shorter than 4 chars", () => {
    const secrets = new Set(["abc"]);
    expect(scrubSecrets("contains abc token", secrets)).toBe(
      "contains abc token",
    );
  });

  test("handles exactly 4-char secrets", () => {
    const secrets = new Set(["abcd"]);
    expect(scrubSecrets("contains abcd token", secrets)).toBe(
      "contains [REDACTED] token",
    );
  });

  test("returns original text when no secrets match", () => {
    const secrets = new Set(["notpresent"]);
    expect(scrubSecrets("clean text here", secrets)).toBe("clean text here");
  });

  test("handles empty secrets set", () => {
    expect(scrubSecrets("any text", new Set())).toBe("any text");
  });

  test("handles empty text", () => {
    const secrets = new Set(["secret"]);
    expect(scrubSecrets("", secrets)).toBe("");
  });
});

// --- initTracing / traceSession / shutdownTracing (no-op mode) ---

describe("tracing no-op mode", () => {
  test("initTracing without key sets no-op mode", () => {
    initTracing({ secretValues: new Set() });
    expect(isTracingInitialized()).toBe(false);
  });

  test("traceSession in no-op mode calls fn directly", async () => {
    initTracing({ secretValues: new Set() });

    let called = false;
    const result = await traceSession("test", { key: "val" }, async () => {
      called = true;
      return 42;
    });

    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  test("traceSession in no-op mode propagates errors from fn", async () => {
    initTracing({ secretValues: new Set() });

    await expect(
      traceSession("test", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("shutdownTracing in no-op mode is a no-op", async () => {
    initTracing({ secretValues: new Set() });
    // Should not throw
    await shutdownTracing();
  });

  test("traceSession returns fn result with correct type", async () => {
    initTracing({ secretValues: new Set() });

    const result = await traceSession(
      "typed-test",
      {},
      async () => ({ status: "ok", count: 5 }),
    );

    expect(result).toEqual({ status: "ok", count: 5 });
  });
});
