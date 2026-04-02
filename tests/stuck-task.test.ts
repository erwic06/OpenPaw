import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getTaskFailureCount } from "../src/db/index.ts";
import { SessionRunner } from "../src/agents/runner.ts";
import type { RunnerDeps } from "../src/agents/runner.ts";
import type { AgentOutput } from "../src/agents/types.ts";
import type { AlertPayload } from "../src/alerts/types.ts";

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

function insertFailedSession(
  db: Database,
  taskId: string,
  state: string = "failed",
): void {
  const id = `sess-${Date.now()}-${Math.random()}`;
  db.prepare(
    `INSERT INTO sessions (id, agent, task_id, model, provider, started_at, ended_at, terminal_state)
     VALUES (?, 'coder', ?, 'claude-sonnet-4-6', 'anthropic', ?, ?, ?)`,
  ).run(id, taskId, new Date().toISOString(), new Date().toISOString(), state);
}

// --- getTaskFailureCount ---

describe("getTaskFailureCount", () => {
  let db: Database;

  beforeEach(() => {
    db = initDb();
  });

  test("returns 0 when no sessions exist", () => {
    expect(getTaskFailureCount(db, "3.1")).toBe(0);
  });

  test("counts lowercase 'failed' sessions", () => {
    insertFailedSession(db, "3.1", "failed");
    insertFailedSession(db, "3.1", "failed");
    expect(getTaskFailureCount(db, "3.1")).toBe(2);
  });

  test("counts uppercase 'FAILED' sessions", () => {
    insertFailedSession(db, "3.1", "FAILED");
    expect(getTaskFailureCount(db, "3.1")).toBe(1);
  });

  test("counts mixed case failures", () => {
    insertFailedSession(db, "3.1", "failed");
    insertFailedSession(db, "3.1", "FAILED");
    insertFailedSession(db, "3.1", "failed");
    expect(getTaskFailureCount(db, "3.1")).toBe(3);
  });

  test("ignores complete sessions", () => {
    insertFailedSession(db, "3.1", "complete");
    insertFailedSession(db, "3.1", "failed");
    expect(getTaskFailureCount(db, "3.1")).toBe(1);
  });

  test("only counts for the specified task", () => {
    insertFailedSession(db, "3.1", "failed");
    insertFailedSession(db, "3.1", "failed");
    insertFailedSession(db, "3.2", "failed");
    expect(getTaskFailureCount(db, "3.1")).toBe(2);
    expect(getTaskFailureCount(db, "3.2")).toBe(1);
  });
});

// --- SessionRunner stuck task behavior ---

describe("SessionRunner stuck task detection", () => {
  const planContent = `### 3.9 -- Test Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none

#### Notes
#### Failure History

---

### 4.0 -- Another Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none

#### Notes
#### Failure History
`;

  let db: Database;
  let planPath: string;
  let sendAlertFn: ReturnType<typeof mock>;
  let alertSystemSendFn: ReturnType<typeof mock>;

  function makeOutput(overrides?: Partial<AgentOutput>): AgentOutput {
    return {
      sessionId: `sess-${Date.now()}`,
      terminalState: "failed",
      artifacts: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      costUsd: 0.005,
      error: "test failure",
      ...overrides,
    };
  }

  beforeEach(async () => {
    db = initDb();
    const tmpDir = `${import.meta.dir}/../.tmp-stuck-test-${Date.now()}`;
    await Bun.write(`${tmpDir}/implementation_plan.md`, planContent);
    planPath = `${tmpDir}/implementation_plan.md`;
    sendAlertFn = mock(() => Promise.resolve());
    alertSystemSendFn = mock(() => Promise.resolve());
  });

  function makeDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
    return {
      db,
      sendAlert: sendAlertFn,
      anthropicApiKey: "test-key",
      openaiApiKey: "test-key",
      repoMount: "/repo",
      branch: "main",
      planPath,
      systemPromptPath: "/prompt.md",
      sandboxDeps: { baseDir: "/tmp/sandboxes" },
      createSandboxFn: mock(() =>
        Promise.resolve({ sessionId: "sb-1", workDir: "/tmp/sb-1" }),
      ),
      destroySandboxFn: mock(() => Promise.resolve()),
      executeSessionFn: mock(() => Promise.resolve(makeOutput())),
      alertSystem: { send: alertSystemSendFn } as any,
      ...overrides,
    };
  }

  test("task with <3 failures is not stuck", async () => {
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");

    const deps = makeDeps();
    const runner = new SessionRunner(deps);

    await runner.runTask({
      id: "3.9",
      title: "Test Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    runner.stop();
    expect(alertSystemSendFn).not.toHaveBeenCalled();
  });

  test("task with 3+ failures triggers stuck_task alert", async () => {
    // Insert 2 prior failures; the runTask will create a 3rd via executeSessionFn
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");

    // We need the runner's session to be recorded in DB for the count.
    // But executeSessionFn returns the output — the session is recorded by the adapter.
    // For this test, insert the 3rd failure manually.
    insertFailedSession(db, "3.9", "failed");

    const deps = makeDeps();
    const runner = new SessionRunner(deps);

    await runner.runTask({
      id: "3.9",
      title: "Test Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    runner.stop();
    expect(alertSystemSendFn).toHaveBeenCalledTimes(1);

    const payload = alertSystemSendFn.mock.calls[0][0] as AlertPayload;
    expect(payload.type).toBe("stuck_task");
    if (payload.type === "stuck_task") {
      expect(payload.taskId).toBe("3.9");
      expect(payload.taskTitle).toBe("Test Task");
      expect(payload.failureCount).toBe(3);
      expect(payload.lastError).toContain("test failure");
    }
  });

  test("stuck task is skipped in drainQueue with log message", async () => {
    // Insert 3 prior failures
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");

    const executeSessionFn = mock(() => Promise.resolve(makeOutput()));
    const deps = makeDeps({ executeSessionFn });
    const runner = new SessionRunner(deps);

    // First run marks it stuck
    await runner.runTask(
      {
        id: "3.9",
        title: "Test Task",
        status: "ready",
        type: "code",
        contract: "contracts/test.md",
        dependencies: [],
      },
    );

    // Reset mock for second enqueue
    executeSessionFn.mockClear();

    // Enqueue the same task — should be skipped
    await runner.enqueue({
      id: "3.9",
      title: "Test Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    runner.stop();
    // executeSessionFn should NOT be called again
    expect(executeSessionFn).not.toHaveBeenCalled();
  });

  test("non-stuck task is dispatched normally alongside stuck task", async () => {
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");

    const successOutput = makeOutput({ terminalState: "complete", error: null });
    const executeSessionFn = mock(() => Promise.resolve(makeOutput()));
    const deps = makeDeps({ executeSessionFn });
    const runner = new SessionRunner(deps);

    // First: mark 3.9 as stuck
    await runner.runTask({
      id: "3.9",
      title: "Test Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    // Reset for next dispatch
    executeSessionFn.mockImplementation(() => Promise.resolve(successOutput));
    executeSessionFn.mockClear();

    // Enqueue a different task — should proceed
    await runner.enqueue({
      id: "4.0",
      title: "Another Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    runner.stop();
    expect(executeSessionFn).toHaveBeenCalledTimes(1);
  });

  test("no alert sent when alertSystem is not provided", async () => {
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");
    insertFailedSession(db, "3.9", "failed");

    const deps = makeDeps({ alertSystem: undefined });
    const runner = new SessionRunner(deps);

    // Should not throw even without alertSystem
    await runner.runTask({
      id: "3.9",
      title: "Test Task",
      status: "ready",
      type: "code",
      contract: "contracts/test.md",
      dependencies: [],
    });

    runner.stop();
    // alertSystem was undefined — no crash
  });

  test("stuckTasks starts empty on new SessionRunner", () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    runner.stop();
    // Verify fresh runner dispatches all tasks (no stuck set)
    // This is implicitly tested by other tests, but explicit check:
    expect(runner.queueLength()).toBe(0);
  });
});
