import type { Database } from "bun:sqlite";
import { PRICING } from "./pricing.ts";

export { PRICING } from "./pricing.ts";
export type { TokenPricing } from "./pricing.ts";

export interface CostTrackerDeps {
  db: Database;
}

/** Calculate cost, insert into cost_log, return the USD amount. */
export function logUsage(
  deps: CostTrackerDeps,
  sessionId: string,
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[model];
  if (!pricing) {
    throw new Error(`No pricing defined for model: ${model}`);
  }

  const amount =
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

  deps.db
    .prepare(
      `INSERT INTO cost_log (session_id, service, amount_usd, logged_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, `${provider}/${model}`, amount, new Date().toISOString());

  return amount;
}

/** Sum all cost_log entries for a session. */
export function getSessionCost(deps: CostTrackerDeps, sessionId: string): number {
  const result = deps.db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total
       FROM cost_log WHERE session_id = ?`,
    )
    .get(sessionId) as { total: number };
  return result.total;
}

/** Sum all cost_log entries for a date (defaults to today). */
export function getDailySpend(deps: CostTrackerDeps, date?: string): number {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const result = deps.db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total
       FROM cost_log WHERE date(logged_at) = date(?)`,
    )
    .get(d) as { total: number };
  return result.total;
}
