import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionRunner } from "../src/agents/runner.ts";
import type { RunnerDeps } from "../src/agents/runner.ts";
import type { Task } from "../src/plan/types.ts";
import type { AgentOutput } from "../src/agents/types.ts";
import type { SandboxHandle } from "../src/sandbox/types.ts";

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

const PLAN_TEMPLATE = `# Test Plan

### 3.9 -- Test Task
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
- **Contract:** contracts/test2.md
- **Dependencies:** none

#### Notes
#### Failure History

---
`;

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  writeFileSync(join(dir, "implementation_plan.md"), PLAN_TEMPLATE);
  writeFileSync(join(dir, "system_prompt.md"), "You are a test agent.");
  return dir;
}

function makeTask(id: string, title?: string): Task {
  return {
    id,
    title: title ?? "Test Task",
    status: "ready",
    type: "code",
    contract: "contracts/test.md",
    dependencies: [],
    assigned: "interactive",
    artifacts: [],
    acceptance: "Tests pass",
    notes: [],
  };
}

function successOutput(): AgentOutput {
  return {
    sessionId: "test-session",
    terminalState: "complete",
    artifacts: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.01,
    error: null,
  };
}

function failedOutput(error: string): AgentOutput {
  return {
    sessionId: "test-session",
    terminalState: "failed",
    artifacts: [],
    usage: { inputTokens: 50, outputTokens: 25 },
    costUsd: 0.005,
    error,
  };
}

const fakeSandbox: SandboxHandle = {
  sessionId: "sandbox-test",
  sandboxId: "sb-123",
  sandbox: {} as any,
};

let db: Database;
let alertMessages: string[];
let testDir: string;

function makeDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
  return {
    db,
    sendAlert: mock(async (msg: string) => {
      alertMessages.push(msg);
    }),
    anthropicApiKey: "test-key",
    openaiApiKey: "test-key",
    repoUrl: "https://github.com/test/repo.git",
    branch: "main",
    planPath: join(testDir, "implementation_plan.md"),
    systemPromptPath: join(testDir, "system_prompt.md"),
    sandboxDeps: { apiKey: "test-daytona-key" },
    createSandboxFn: mock(async () => fakeSandbox),
    destroySandboxFn: mock(async () => {}),
    executeSessionFn: mock(async () => successOutput()),
    ...overrides,
  };
}

beforeEach(() => {
  db = freshDb();
  alertMessages = [];
  testDir = makeTestDir();
});

// --- runTask lifecycle ---

describe("SessionRunner.runTask", () => {
  it("executes full lifecycle on success", async () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    // Plan updated to complete
    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    // Sandbox created and destroyed
    expect(deps.createSandboxFn).toHaveBeenCalled();
    expect(deps.destroySandboxFn).toHaveBeenCalled();

    // Alert sent
    expect(alertMessages.length).toBeGreaterThanOrEqual(1);
    expect(alertMessages.some((m) => m.includes("complete"))).toBe(true);

    runner.stop();
  });

  it("includes cost in notification", async () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(alertMessages.some((m) => m.includes("$0.0100"))).toBe(true);

    runner.stop();
  });

  it("marks task failed on session failure", async () => {
    const deps = makeDeps({
      executeSessionFn: mock(async () => failedOutput("Tests did not pass")),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(plan).toContain("Tests did not pass");

    expect(alertMessages.some((m) => m.includes("failed"))).toBe(true);

    runner.stop();
  });

  it("marks task in-progress before execution", async () => {
    let statusDuringExecution = "";
    const deps = makeDeps({
      executeSessionFn: mock(async () => {
        statusDuringExecution = readFileSync(
          join(testDir, "implementation_plan.md"),
          "utf-8",
        );
        return successOutput();
      }),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(statusDuringExecution).toContain("- **Status:** in-progress");

    runner.stop();
  });

  it("destroys sandbox on success", async () => {
    const destroyFn = mock(async () => {});
    const deps = makeDeps({ destroySandboxFn: destroyFn });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(destroyFn).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("destroys sandbox on error", async () => {
    const destroyFn = mock(async () => {});
    const deps = makeDeps({
      executeSessionFn: mock(async () => {
        throw new Error("boom");
      }),
      destroySandboxFn: destroyFn,
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    // Sandbox still cleaned up despite error
    expect(destroyFn).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("handles sandbox creation failure", async () => {
    const deps = makeDeps({
      createSandboxFn: mock(async () => {
        throw new Error("Daytona unavailable");
      }),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");

    expect(alertMessages.some((m) => m.includes("Daytona unavailable"))).toBe(
      true,
    );

    runner.stop();
  });

  it("sends alert even when sandbox creation fails", async () => {
    const deps = makeDeps({
      createSandboxFn: mock(async () => {
        throw new Error("network error");
      }),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(alertMessages.length).toBeGreaterThanOrEqual(1);

    runner.stop();
  });

  it("does not destroy sandbox if creation failed", async () => {
    const destroyFn = mock(async () => {});
    const deps = makeDeps({
      createSandboxFn: mock(async () => {
        throw new Error("create failed");
      }),
      destroySandboxFn: destroyFn,
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(destroyFn).not.toHaveBeenCalled();

    runner.stop();
  });
});

// --- Sequential dispatch ---

describe("SessionRunner sequential dispatch", () => {
  it("processes tasks one at a time", async () => {
    const executionOrder: string[] = [];
    let resolveBlock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const deps = makeDeps({
      executeSessionFn: mock(async (task: Task) => {
        executionOrder.push(`start-${task.id}`);
        if (task.id === "3.9") {
          firstStarted();
          await blocked;
        }
        executionOrder.push(`end-${task.id}`);
        return successOutput();
      }),
    });

    const runner = new SessionRunner(deps);

    // First task starts but blocks
    const p1 = runner.enqueue(makeTask("3.9"));
    await firstStartedPromise;

    // Second task is queued while first is running
    runner.enqueue(makeTask("4.0", "Another Task"));

    expect(runner.isBusy()).toBe(true);
    expect(runner.queueLength()).toBe(1);

    // Release first task
    resolveBlock();
    await p1;

    expect(executionOrder).toEqual([
      "start-3.9",
      "end-3.9",
      "start-4.0",
      "end-4.0",
    ]);

    runner.stop();
  });

  it("second task runs after first completes", async () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);

    await runner.enqueue(makeTask("3.9"));
    await runner.enqueue(makeTask("4.0", "Another Task"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("### 3.9 -- Test Task\n- **Status:** complete");
    expect(plan).toContain("### 4.0 -- Another Task\n- **Status:** complete");

    runner.stop();
  });

  it("is not busy after all tasks complete", async () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);

    await runner.enqueue(makeTask("3.9"));

    expect(runner.isBusy()).toBe(false);
    expect(runner.queueLength()).toBe(0);

    runner.stop();
  });
});

// --- enqueue ---

describe("SessionRunner.enqueue", () => {
  it("queues tasks when busy", async () => {
    let blockResolve!: () => void;
    const blocked = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });

    const deps = makeDeps({
      executeSessionFn: mock(async (task: Task) => {
        if (task.id === "3.9") {
          started();
          await blocked;
        }
        return successOutput();
      }),
    });

    const runner = new SessionRunner(deps);

    const p = runner.enqueue(makeTask("3.9"));
    await startedP;

    runner.enqueue(makeTask("4.0", "Another Task"));
    expect(runner.queueLength()).toBe(1);

    blockResolve();
    await p;

    expect(runner.isBusy()).toBe(false);
    expect(runner.queueLength()).toBe(0);

    runner.stop();
  });
});

// --- Notification ---

describe("SessionRunner notifications", () => {
  it("sends Telegram notification on success", async () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(alertMessages.length).toBe(1);
    expect(alertMessages[0]).toContain("3.9");
    expect(alertMessages[0]).toContain("complete");

    runner.stop();
  });

  it("sends Telegram notification on failure", async () => {
    const deps = makeDeps({
      executeSessionFn: mock(async () => failedOutput("compile error")),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(alertMessages.length).toBe(1);
    expect(alertMessages[0]).toContain("3.9");
    expect(alertMessages[0]).toContain("failed");

    runner.stop();
  });

  it("sends alert on exception during execution", async () => {
    const deps = makeDeps({
      executeSessionFn: mock(async () => {
        throw new Error("unexpected crash");
      }),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("3.9"));

    expect(alertMessages.some((m) => m.includes("unexpected crash"))).toBe(
      true,
    );

    runner.stop();
  });
});

// --- stop ---

describe("SessionRunner.stop", () => {
  it("stops the monitor without error", () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    runner.stop();
    // No error thrown
  });

  it("double stop is safe", () => {
    const deps = makeDeps();
    const runner = new SessionRunner(deps);
    runner.stop();
    runner.stop();
  });
});
