import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initGates,
  resetGates,
  requestApproval,
  _handleMessage,
  setDecisionLogPath,
} from "../src/gates/index.ts";
import type { GateDeps } from "../src/gates/index.ts";
import { AlertSystem } from "../src/alerts/index.ts";
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG } from "../src/budget/index.ts";

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
    CREATE TABLE IF NOT EXISTS hitl_gates (
      id TEXT PRIMARY KEY,
      gate_type TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      decision TEXT,
      context_summary TEXT
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

// --- Decision Logging ---

describe("decision logging", () => {
  let db: Database;
  let tmpLogPath: string;
  let sendFn: ReturnType<typeof mock>;
  let messageHandler: ((chatId: number, text: string) => void | Promise<void>) | null;

  beforeEach(() => {
    db = initDb();
    const tmpDir = join(tmpdir(), `decision-log-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tmpLogPath = join(tmpDir, "decisions.jsonl");
    setDecisionLogPath(tmpLogPath);
    messageHandler = null;

    sendFn = mock(() => Promise.resolve());
    const gateDeps: GateDeps = {
      db,
      chatId: 12345,
      send: sendFn,
      onMessage: (handler) => {
        messageHandler = handler;
      },
    };
    initGates(gateDeps);
  });

  afterEach(() => {
    resetGates();
    try {
      unlinkSync(tmpLogPath);
    } catch {
      /* may not exist */
    }
  });

  test("appends JSONL entry on gate resolution", async () => {
    const resultPromise = requestApproval({
      gateType: "plan",
      taskId: "3.1",
      sessionId: "sess-abc",
      contextSummary: "Review the plan for task 3.1",
    });

    // Approve the gate
    await messageHandler!(12345, "approve");
    const result = await resultPromise;
    expect(result.decision).toBe("approved");

    // Verify log file
    const content = readFileSync(tmpLogPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.gate_type).toBe("plan");
    expect(entry.task_id).toBe("3.1");
    expect(entry.session_id).toBe("sess-abc");
    expect(entry.decision).toBe("approved");
    expect(entry.decided_at).toBeTruthy();
    expect(entry.context_summary_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("context_summary_hash is SHA-256 of context text", async () => {
    const contextText = "Deploy auth to production";
    const resultPromise = requestApproval({
      gateType: "deploy",
      taskId: "3.11",
      sessionId: "sess-xyz",
      contextSummary: contextText,
    });

    await messageHandler!(12345, "deny");
    await resultPromise;

    const content = readFileSync(tmpLogPath, "utf-8").trim();
    const entry = JSON.parse(content);

    const { createHash } = await import("crypto");
    const expectedHash = createHash("sha256").update(contextText).digest("hex");
    expect(entry.context_summary_hash).toBe(expectedHash);
    expect(entry.decision).toBe("denied");
  });

  test("decision log failure does not block gate resolution", async () => {
    // Set path to an invalid location
    setDecisionLogPath("/nonexistent-dir/decisions.jsonl");

    const resultPromise = requestApproval({
      gateType: "spend",
      taskId: null,
      sessionId: null,
      contextSummary: "Budget exceeded",
    });

    await messageHandler!(12345, "approve");
    const result = await resultPromise;

    // Gate still resolves despite log failure
    expect(result.decision).toBe("approved");
  });
});

// --- AlertSystem wiring ---

describe("AlertSystem wiring", () => {
  test("uses alertsChatId when provided", async () => {
    const sendFn = mock(() => Promise.resolve());
    const system = new AlertSystem({
      sendMessage: sendFn,
      alertsChatId: "999",
      fallbackChatId: "123",
    });

    await system.send({
      type: "budget_hard_stop",
      dailySpendUsd: 50,
      dailyLimitUsd: 50,
    });

    const [chatId] = sendFn.mock.calls[0];
    expect(chatId).toBe("999");
  });

  test("falls back to fallbackChatId when alertsChatId undefined", async () => {
    const sendFn = mock(() => Promise.resolve());
    const system = new AlertSystem({
      sendMessage: sendFn,
      fallbackChatId: "123",
    });

    await system.send({
      type: "orchestrator_restart",
      orphanedCount: 1,
      taskIds: ["2.1"],
    });

    const [chatId] = sendFn.mock.calls[0];
    expect(chatId).toBe("123");
  });
});

// --- BudgetEnforcer wiring ---

describe("BudgetEnforcer wiring", () => {
  test("constructs with default config and works in ok state", () => {
    const db = initDb();
    const alertSystem = new AlertSystem({
      sendMessage: mock(() => Promise.resolve()),
      fallbackChatId: "123",
    });

    const enforcer = new BudgetEnforcer({
      db,
      alertSystem,
      config: DEFAULT_BUDGET_CONFIG,
      nowFn: () => new Date("2026-04-02T12:00:00Z"),
    });

    expect(enforcer.checkBudget()).toBe("ok");
  });
});
