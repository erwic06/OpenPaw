import type { AgentOutput } from "./types.ts";

export interface FallbackDeps {
  sendAlert: (message: string) => Promise<void>;
  /** Override for testing. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

/** Check if an error is retryable (rate limit, quota, connection issue). */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("overloaded") ||
    msg.includes("503") ||
    msg.includes("529") ||
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused")
  );
}

async function executeWithRetries(
  execute: () => Promise<AgentOutput>,
  sleep: (ms: number) => Promise<void>,
): Promise<AgentOutput> {
  let lastError: unknown;

  // Initial attempt
  try {
    return await execute();
  } catch (err) {
    if (!isRetryableError(err)) throw err;
    lastError = err;
  }

  // Retry attempts with exponential backoff
  for (const delay of RETRY_DELAYS_MS) {
    await sleep(delay);
    try {
      return await execute();
    } catch (err) {
      if (!isRetryableError(err)) throw err;
      lastError = err;
    }
  }

  throw lastError;
}

/**
 * Execute a session with retry + fallback.
 *
 * Tries the primary executor with exponential backoff (30s, 60s, 120s).
 * If all retries fail with retryable errors, sends a Telegram alert and
 * activates the fallback. If fallback also fails, returns a failed AgentOutput.
 */
export async function executeWithFallback(
  primaryModel: string,
  fallbackModel: string,
  executePrimary: () => Promise<AgentOutput>,
  executeFallback: () => Promise<AgentOutput>,
  deps: FallbackDeps,
): Promise<AgentOutput> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  try {
    return await executeWithRetries(executePrimary, sleep);
  } catch (primaryErr) {
    // Non-retryable errors propagate immediately (e.g. invalid API key)
    if (!isRetryableError(primaryErr)) throw primaryErr;

    // Primary exhausted after retries -- notify and try fallback
    await deps.sendAlert(
      `Fallback activated: ${primaryModel} \u2192 ${fallbackModel}`,
    );

    try {
      return await executeWithRetries(executeFallback, sleep);
    } catch {
      // All providers exhausted
      return {
        sessionId: "",
        terminalState: "failed",
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        error: `All providers exhausted. Primary (${primaryModel}) and fallback (${fallbackModel}) both failed after retries.`,
      };
    }
  }
}
