import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePlan } from "../src/plan/parser.ts";
import { SessionRunner, assembleDeployContext } from "../src/agents/runner.ts";
import type { RunnerDeps } from "../src/agents/runner.ts";
import type { Task } from "../src/plan/types.ts";
import type { AgentOutput } from "../src/agents/types.ts";
import type { SandboxHandle } from "../src/sandbox/types.ts";
import type { GateRequest, GateResult } from "../src/gates/types.ts";
import type { ReviewResult } from "../src/review/types.ts";

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

// --- Parser: deploy tag ---

describe("parsePlan deploy tag", () => {
  it("parses deploy: production", () => {
    const content = `### 1.1 -- Deploy Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works
- **Deploy:** production

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].deploy).toBe("production");
  });

  it("parses deploy: staging", () => {
    const content = `### 1.1 -- Staging Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works
- **Deploy:** staging

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks[0].deploy).toBe("staging");
  });

  it("leaves deploy undefined when not present", () => {
    const content = `### 1.1 -- Normal Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks[0].deploy).toBeUndefined();
  });

  it("ignores invalid deploy values", () => {
    const content = `### 1.1 -- Bad Deploy
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Deploy:** development

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks[0].deploy).toBeUndefined();
  });
});

// --- assembleDeployContext ---

describe("assembleDeployContext", () => {
  const task: Task = {
    id: "3.11",
    title: "Deploy Gate Wiring",
    status: "complete",
    type: "code",
    contract: "contracts/3.11.md",
    dependencies: [],
    assigned: "interactive",
    artifacts: [],
    acceptance: "Tests pass",
    notes: [],
    deploy: "production",
  };

  const output: AgentOutput = {
    sessionId: "session-123",
    terminalState: "complete",
    artifacts: [],
    usage: { inputTokens: 1000, outputTokens: 500 },
    costUsd: 0.05,
    error: null,
  };

  it("includes task info and deploy target", () => {
    const ctx = assembleDeployContext(task, output, null, "");
    expect(ctx).toContain("Task: 3.11");
    expect(ctx).toContain("Target: production");
  });

  it("includes session info", () => {
    const ctx = assembleDeployContext(task, output, null, "");
    expect(ctx).toContain("Status: complete");
    expect(ctx).toContain("Cost: $0.0500");
    expect(ctx).toContain("1000 in / 500 out");
  });

  it("includes review when available", () => {
    const review: ReviewResult = {
      verdict: "APPROVE",
      summary: "Looks good",
      findings: [
        { severity: "nit", file: "x.ts", line: 1, description: "minor thing" },
      ],
    };
    const ctx = assembleDeployContext(task, output, review, "");
    expect(ctx).toContain("Verdict: APPROVE");
    expect(ctx).toContain("Looks good");
    expect(ctx).toContain("[nit] x.ts:1");
  });

  it("omits review section when not available", () => {
    const ctx = assembleDeployContext(task, output, null, "diff content");
    expect(ctx).not.toContain("Code Review");
  });

  it("includes git diff", () => {
    const ctx = assembleDeployContext(task, output, null, "--- a/file.ts\n+++ b/file.ts");
    expect(ctx).toContain("Git Diff");
    expect(ctx).toContain("--- a/file.ts");
  });

  it("truncates long diffs", () => {
    const longDiff = "x".repeat(3000);
    const ctx = assembleDeployContext(task, output, null, longDiff);
    expect(ctx).toContain("truncated");
    expect(ctx).toContain("3000 chars total");
    expect(ctx.length).toBeLessThan(3000);
  });
});

// --- Runner deploy gate integration ---

const PLAN_WITH_DEPLOY = `# Test Plan

### 3.9 -- Deploy Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none
- **Deploy:** production

#### Notes
#### Failure History

---
`;

const PLAN_WITHOUT_DEPLOY = `# Test Plan

### 3.9 -- Normal Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none

#### Notes
#### Failure History

---
`;

function makeTask(deploy?: "production" | "staging"): Task {
  return {
    id: "3.9",
    title: deploy ? "Deploy Task" : "Normal Task",
    status: "ready",
    type: "code",
    contract: "contracts/test.md",
    dependencies: [],
    assigned: "interactive",
    artifacts: [],
    acceptance: "Tests pass",
    notes: [],
    deploy,
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

const fakeSandbox: SandboxHandle = {
  sessionId: "sandbox-test",
  workDir: "/tmp/test-workspace",
};

describe("Runner deploy gate integration", () => {
  let db: Database;
  let alertMessages: string[];
  let testDir: string;

  beforeEach(() => {
    db = freshDb();
    alertMessages = [];
    testDir = mkdtempSync(join(tmpdir(), "deploy-gate-test-"));
    writeFileSync(join(testDir, "system_prompt.md"), "You are a test agent.");
  });

  function makeDeps(
    plan: string,
    overrides?: Partial<RunnerDeps>,
  ): RunnerDeps {
    writeFileSync(join(testDir, "implementation_plan.md"), plan);
    return {
      db,
      sendAlert: mock(async (msg: string) => {
        alertMessages.push(msg);
      }),
      anthropicApiKey: "test-key",
      openaiApiKey: "test-key",
      repoMount: "/repo",
      branch: "main",
      planPath: join(testDir, "implementation_plan.md"),
      systemPromptPath: join(testDir, "system_prompt.md"),
      sandboxDeps: { baseDir: "/tmp/workspaces" },
      createSandboxFn: mock(async () => fakeSandbox),
      destroySandboxFn: mock(async () => {}),
      executeSessionFn: mock(async () => successOutput()),
      ...overrides,
    };
  }

  it("triggers deploy gate for deploy-tagged task on success", async () => {
    const gateRequests: GateRequest[] = [];
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      requestApprovalFn: mock(
        async (req: GateRequest): Promise<GateResult> => {
          gateRequests.push(req);
          return {
            gateId: "gate-test",
            decision: "approved",
            feedback: [],
            decidedAt: new Date().toISOString(),
          };
        },
      ),
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    expect(gateRequests).toHaveLength(1);
    expect(gateRequests[0].gateType).toBe("deploy");
    expect(gateRequests[0].taskId).toBe("3.9");
    expect(gateRequests[0].contextSummary).toContain("production");

    runner.stop();
  });

  it("task completes when deploy gate is approved", async () => {
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      requestApprovalFn: mock(
        async (): Promise<GateResult> => ({
          gateId: "gate-test",
          decision: "approved",
          feedback: [],
          decidedAt: new Date().toISOString(),
        }),
      ),
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });

  it("task blocked when deploy gate is denied", async () => {
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      requestApprovalFn: mock(
        async (): Promise<GateResult> => ({
          gateId: "gate-test",
          decision: "denied",
          feedback: [],
          decidedAt: new Date().toISOString(),
        }),
      ),
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** blocked");
    expect(plan).toContain("Deploy denied");

    runner.stop();
  });

  it("task blocked when deploy gate times out", async () => {
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      requestApprovalFn: mock(
        async (): Promise<GateResult> => ({
          gateId: "gate-test",
          decision: "timeout",
          feedback: [],
          decidedAt: new Date().toISOString(),
        }),
      ),
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** blocked");
    expect(plan).toContain("Deploy timeout");

    runner.stop();
  });

  it("does not trigger deploy gate for non-deploy tasks", async () => {
    const requestFn = mock(
      async (): Promise<GateResult> => ({
        gateId: "gate-test",
        decision: "approved",
        feedback: [],
        decidedAt: new Date().toISOString(),
      }),
    );
    const deps = makeDeps(PLAN_WITHOUT_DEPLOY, {
      requestApprovalFn: requestFn,
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    expect(requestFn).not.toHaveBeenCalled();

    runner.stop();
  });

  it("does not trigger deploy gate when coder session fails", async () => {
    const requestFn = mock(
      async (): Promise<GateResult> => ({
        gateId: "gate-test",
        decision: "approved",
        feedback: [],
        decidedAt: new Date().toISOString(),
      }),
    );
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      executeSessionFn: mock(
        async (): Promise<AgentOutput> => ({
          sessionId: "test",
          terminalState: "failed",
          artifacts: [],
          usage: { inputTokens: 50, outputTokens: 25 },
          costUsd: 0.005,
          error: "compile error",
        }),
      ),
      requestApprovalFn: requestFn,
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    expect(requestFn).not.toHaveBeenCalled();

    runner.stop();
  });

  it("context includes review summary when available", async () => {
    const gateRequests: GateRequest[] = [];
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      runReviewFn: mock(
        async (): Promise<ReviewResult> => ({
          verdict: "APPROVE",
          summary: "LGTM",
          findings: [],
        }),
      ),
      requestApprovalFn: mock(
        async (req: GateRequest): Promise<GateResult> => {
          gateRequests.push(req);
          return {
            gateId: "gate-test",
            decision: "approved",
            feedback: [],
            decidedAt: new Date().toISOString(),
          };
        },
      ),
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    expect(gateRequests[0].contextSummary).toContain("APPROVE");
    expect(gateRequests[0].contextSummary).toContain("LGTM");

    runner.stop();
  });

  it("deploy gate not triggered when review rejects", async () => {
    const requestFn = mock(
      async (): Promise<GateResult> => ({
        gateId: "gate-test",
        decision: "approved",
        feedback: [],
        decidedAt: new Date().toISOString(),
      }),
    );
    const deps = makeDeps(PLAN_WITH_DEPLOY, {
      runReviewFn: mock(
        async (): Promise<ReviewResult> => ({
          verdict: "REQUEST_CHANGES",
          summary: "Bad code",
          findings: [
            {
              severity: "critical",
              file: "x.ts",
              line: 1,
              description: "injection",
            },
          ],
        }),
      ),
      requestApprovalFn: requestFn,
    });

    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask("production"));

    // Review failed → task failed → no deploy gate
    expect(requestFn).not.toHaveBeenCalled();
    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");

    runner.stop();
  });
});
