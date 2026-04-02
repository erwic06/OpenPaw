export type { BudgetConfig, BudgetStatus, BudgetEnforcerDeps } from "./types.ts";
export { DEFAULT_BUDGET_CONFIG } from "./types.ts";

import type { BudgetStatus, BudgetEnforcerDeps } from "./types.ts";
import { getDailySpend } from "../costs/index.ts";
import { requestApproval as realRequestApproval } from "../gates/index.ts";

export class BudgetEnforcer {
  private lastWarningDate: string | null = null;

  constructor(private deps: BudgetEnforcerDeps) {}

  checkBudget(): BudgetStatus {
    const today = this.getToday();
    const spent = getDailySpend({ db: this.deps.db }, today);
    const { dailyLimitUsd, warningThresholdPct } = this.deps.config;

    if (spent >= dailyLimitUsd) return "exceeded";
    if (spent >= dailyLimitUsd * warningThresholdPct) return "warning";
    return "ok";
  }

  async enforceBudget(): Promise<boolean> {
    const status = this.checkBudget();
    if (status === "ok") return true;

    const today = this.getToday();
    const spent = getDailySpend({ db: this.deps.db }, today);
    const { dailyLimitUsd, warningThresholdPct } = this.deps.config;

    if (status === "warning") {
      if (this.lastWarningDate !== today) {
        await this.deps.alertSystem.send({
          type: "budget_warning",
          dailySpendUsd: spent,
          dailyLimitUsd,
          thresholdPct: Math.round(warningThresholdPct * 100),
        });
        this.lastWarningDate = today;
      }
      return true;
    }

    // exceeded — hard stop
    await this.deps.alertSystem.send({
      type: "budget_hard_stop",
      dailySpendUsd: spent,
      dailyLimitUsd,
    });

    const requestFn = this.deps.requestApprovalFn ?? realRequestApproval;
    const result = await requestFn({
      gateType: "spend",
      taskId: null,
      sessionId: null,
      contextSummary: `Daily budget exceeded: $${spent.toFixed(2)} / $${dailyLimitUsd}. Reply approve to resume dispatch.`,
    });

    return result.decision === "approved";
  }

  private getToday(): string {
    return (this.deps.nowFn ?? (() => new Date()))().toISOString().slice(0, 10);
  }
}
