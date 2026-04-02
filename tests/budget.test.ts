import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG } from "../src/budget/index.ts";
import type { BudgetEnforcerDeps } from "../src/budget/types.ts";
import type { AlertPayload } from "../src/alerts/types.ts";
import type { GateResult } from "../src/gates/types.ts";

function initDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      task_id TEXT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      terminal_state TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      error TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      service TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      logged_at TEXT NOT NULL
    )
  `);
  return db;
}

function insertCost(db: Database, amount: number, date: string): void {
  db.prepare(
    `INSERT INTO cost_log (session_id, service, amount_usd, logged_at) VALUES (?, ?, ?, ?)`,
  ).run(`sess-${Date.now()}-${Math.random()}`, "test/model", amount, `${date}T12:00:00Z`);
}

function makeDeps(
  db: Database,
  overrides?: Partial<BudgetEnforcerDeps>,
): BudgetEnforcerDeps {
  return {
    db,
    alertSystem: { send: mock(() => Promise.resolve()) },
    config: DEFAULT_BUDGET_CONFIG,
    nowFn: () => new Date("2026-04-02T12:00:00Z"),
    ...overrides,
  };
}

const TODAY = "2026-04-02";

describe("BudgetEnforcer", () => {
  let db: Database;

  beforeEach(() => {
    db = initDb();
  });

  // --- checkBudget ---

  describe("checkBudget", () => {
    test("returns 'ok' when spend < 80%", () => {
      insertCost(db, 30, TODAY);
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("ok");
    });

    test("returns 'warning' when 80% <= spend < 100%", () => {
      insertCost(db, 40, TODAY);
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("warning");
    });

    test("returns 'warning' at exactly 80%", () => {
      insertCost(db, 40, TODAY);
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("warning");
    });

    test("returns 'exceeded' when spend >= 100%", () => {
      insertCost(db, 50, TODAY);
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("exceeded");
    });

    test("returns 'exceeded' when spend > 100%", () => {
      insertCost(db, 60, TODAY);
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("exceeded");
    });

    test("returns 'ok' with zero spend", () => {
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("ok");
    });

    test("ignores spend from other dates", () => {
      insertCost(db, 100, "2026-04-01");
      const enforcer = new BudgetEnforcer(makeDeps(db));
      expect(enforcer.checkBudget()).toBe("ok");
    });
  });

  // --- enforceBudget ---

  describe("enforceBudget", () => {
    test("returns true and sends no alert when ok", async () => {
      insertCost(db, 10, TODAY);
      const deps = makeDeps(db);
      const enforcer = new BudgetEnforcer(deps);

      const result = await enforcer.enforceBudget();
      expect(result).toBe(true);
      expect(deps.alertSystem.send).not.toHaveBeenCalled();
    });

    test("returns true and sends budget_warning at 80%", async () => {
      insertCost(db, 42, TODAY);
      const deps = makeDeps(db);
      const enforcer = new BudgetEnforcer(deps);

      const result = await enforcer.enforceBudget();
      expect(result).toBe(true);
      expect(deps.alertSystem.send).toHaveBeenCalledTimes(1);

      const payload = (deps.alertSystem.send as ReturnType<typeof mock>).mock
        .calls[0][0] as AlertPayload;
      expect(payload.type).toBe("budget_warning");
      if (payload.type === "budget_warning") {
        expect(payload.dailySpendUsd).toBe(42);
        expect(payload.dailyLimitUsd).toBe(50);
        expect(payload.thresholdPct).toBe(80);
      }
    });

    test("only sends warning once per day", async () => {
      insertCost(db, 42, TODAY);
      const deps = makeDeps(db);
      const enforcer = new BudgetEnforcer(deps);

      await enforcer.enforceBudget();
      await enforcer.enforceBudget();
      await enforcer.enforceBudget();

      expect(deps.alertSystem.send).toHaveBeenCalledTimes(1);
    });

    test("sends warning again on a new day", async () => {
      insertCost(db, 42, TODAY);
      const deps = makeDeps(db);
      let currentDate = new Date("2026-04-02T12:00:00Z");
      deps.nowFn = () => currentDate;

      const enforcer = new BudgetEnforcer(deps);

      await enforcer.enforceBudget();
      expect(deps.alertSystem.send).toHaveBeenCalledTimes(1);

      // Next day — need new spend too
      currentDate = new Date("2026-04-03T12:00:00Z");
      insertCost(db, 45, "2026-04-03");
      await enforcer.enforceBudget();
      expect(deps.alertSystem.send).toHaveBeenCalledTimes(2);
    });

    test("returns false when exceeded and gate denied", async () => {
      insertCost(db, 55, TODAY);
      const deps = makeDeps(db, {
        requestApprovalFn: mock(() =>
          Promise.resolve({
            gateId: "gate-1",
            decision: "denied" as const,
            feedback: [],
            decidedAt: new Date().toISOString(),
          }),
        ),
      });
      const enforcer = new BudgetEnforcer(deps);

      const result = await enforcer.enforceBudget();
      expect(result).toBe(false);

      const payload = (deps.alertSystem.send as ReturnType<typeof mock>).mock
        .calls[0][0] as AlertPayload;
      expect(payload.type).toBe("budget_hard_stop");
    });

    test("returns true when exceeded and gate approved", async () => {
      insertCost(db, 55, TODAY);
      const deps = makeDeps(db, {
        requestApprovalFn: mock(() =>
          Promise.resolve({
            gateId: "gate-1",
            decision: "approved" as const,
            feedback: [],
            decidedAt: new Date().toISOString(),
          }),
        ),
      });
      const enforcer = new BudgetEnforcer(deps);

      const result = await enforcer.enforceBudget();
      expect(result).toBe(true);
    });

    test("returns false when exceeded and gate times out", async () => {
      insertCost(db, 55, TODAY);
      const deps = makeDeps(db, {
        requestApprovalFn: mock(() =>
          Promise.resolve({
            gateId: "gate-1",
            decision: "timeout" as const,
            feedback: [],
            decidedAt: new Date().toISOString(),
          }),
        ),
      });
      const enforcer = new BudgetEnforcer(deps);

      const result = await enforcer.enforceBudget();
      expect(result).toBe(false);
    });

    test("sends budget_hard_stop alert before requesting gate", async () => {
      insertCost(db, 55, TODAY);
      const callOrder: string[] = [];
      const deps = makeDeps(db, {
        alertSystem: {
          send: mock(async () => {
            callOrder.push("alert");
          }),
        },
        requestApprovalFn: mock(async () => {
          callOrder.push("gate");
          return {
            gateId: "gate-1",
            decision: "approved" as const,
            feedback: [],
            decidedAt: new Date().toISOString(),
          };
        }),
      });
      const enforcer = new BudgetEnforcer(deps);

      await enforcer.enforceBudget();
      expect(callOrder).toEqual(["alert", "gate"]);
    });

    test("spend gate context includes dollar amounts", async () => {
      insertCost(db, 55, TODAY);
      const requestFn = mock(
        async (): Promise<GateResult> => ({
          gateId: "gate-1",
          decision: "denied",
          feedback: [],
          decidedAt: new Date().toISOString(),
        }),
      );
      const deps = makeDeps(db, { requestApprovalFn: requestFn });
      const enforcer = new BudgetEnforcer(deps);

      await enforcer.enforceBudget();

      const request = requestFn.mock.calls[0][0];
      expect(request.gateType).toBe("spend");
      expect(request.contextSummary).toContain("$55.00");
      expect(request.contextSummary).toContain("$50");
    });
  });
});
