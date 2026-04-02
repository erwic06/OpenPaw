import type { Database } from "bun:sqlite";
import type { AlertPayload } from "../alerts/types.ts";
import type { GateRequest, GateResult } from "../gates/types.ts";

export interface BudgetConfig {
  dailyLimitUsd: number;
  warningThresholdPct: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  dailyLimitUsd: 50,
  warningThresholdPct: 0.8,
};

export type BudgetStatus = "ok" | "warning" | "exceeded";

export interface BudgetEnforcerDeps {
  db: Database;
  alertSystem: { send(payload: AlertPayload): Promise<void> };
  requestApprovalFn?: (request: GateRequest) => Promise<GateResult>;
  config: BudgetConfig;
  nowFn?: () => Date;
}
