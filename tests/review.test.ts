import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseReviewResult,
  buildReviewPrompt,
  runCodeReview,
} from "../src/review/index.ts";
import type { ReviewDeps, ReviewExecutor } from "../src/review/index.ts";
import type { ReviewResult } from "../src/review/types.ts";
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

// --- parseReviewResult ---

describe("parseReviewResult", () => {
  const validResult = {
    verdict: "APPROVE",
    summary: "Changes look correct",
    findings: [],
  };

  const resultWithFindings = {
    verdict: "REQUEST_CHANGES",
    summary: "Found critical issues",
    findings: [
      {
        severity: "critical",
        file: "src/index.ts",
        line: 42,
        description: "SQL injection vulnerability",
      },
      {
        severity: "minor",
        file: "src/utils.ts",
        line: 10,
        description: "Unused variable",
      },
    ],
  };

  it("parses bare JSON", () => {
    const result = parseReviewResult(JSON.stringify(validResult));
    expect(result.verdict).toBe("APPROVE");
    expect(result.summary).toBe("Changes look correct");
    expect(result.findings).toHaveLength(0);
  });

  it("parses JSON with findings", () => {
    const result = parseReviewResult(JSON.stringify(resultWithFindings));
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe("critical");
    expect(result.findings[0].file).toBe("src/index.ts");
    expect(result.findings[0].line).toBe(42);
    expect(result.findings[1].severity).toBe("minor");
  });

  it("parses code-fenced JSON", () => {
    const text = "```json\n" + JSON.stringify(validResult) + "\n```";
    const result = parseReviewResult(text);
    expect(result.verdict).toBe("APPROVE");
  });

  it("parses code-fenced JSON without language tag", () => {
    const text = "```\n" + JSON.stringify(validResult) + "\n```";
    const result = parseReviewResult(text);
    expect(result.verdict).toBe("APPROVE");
  });

  it("handles whitespace around JSON", () => {
    const text = "  \n" + JSON.stringify(validResult) + "\n  ";
    const result = parseReviewResult(text);
    expect(result.verdict).toBe("APPROVE");
  });

  it("throws on empty string", () => {
    expect(() => parseReviewResult("")).toThrow("Empty review output");
  });

  it("throws on non-JSON text", () => {
    expect(() => parseReviewResult("The code looks fine")).toThrow(
      "No JSON found",
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReviewResult("{invalid json}")).toThrow();
  });

  it("throws on invalid verdict", () => {
    const bad = { ...validResult, verdict: "MAYBE" };
    expect(() => parseReviewResult(JSON.stringify(bad))).toThrow(
      "Invalid verdict",
    );
  });

  it("throws on missing summary", () => {
    const bad = { verdict: "APPROVE", findings: [] };
    expect(() => parseReviewResult(JSON.stringify(bad))).toThrow(
      "Missing or invalid summary",
    );
  });

  it("throws on missing findings array", () => {
    const bad = { verdict: "APPROVE", summary: "ok" };
    expect(() => parseReviewResult(JSON.stringify(bad))).toThrow(
      "Missing or invalid findings",
    );
  });

  it("throws on invalid finding severity", () => {
    const bad = {
      verdict: "APPROVE",
      summary: "ok",
      findings: [{ severity: "warning", file: "x.ts", line: 1, description: "test" }],
    };
    expect(() => parseReviewResult(JSON.stringify(bad))).toThrow(
      "Invalid severity",
    );
  });

  it("coerces missing finding fields to defaults", () => {
    const input = {
      verdict: "APPROVE",
      summary: "ok",
      findings: [{ severity: "nit" }],
    };
    const result = parseReviewResult(JSON.stringify(input));
    expect(result.findings[0].file).toBe("");
    expect(result.findings[0].line).toBe(0);
    expect(result.findings[0].description).toBe("");
  });
});

// --- buildReviewPrompt ---

describe("buildReviewPrompt", () => {
  it("embeds task ID and diff", () => {
    const prompt = buildReviewPrompt("3.10", "--- a/file.ts\n+++ b/file.ts");
    expect(prompt).toContain("task 3.10");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("--- a/file.ts");
  });
});

// --- runCodeReview ---

describe("runCodeReview", () => {
  let db: Database;
  let alertMessages: string[];
  let testDir: string;

  beforeEach(() => {
    db = freshDb();
    alertMessages = [];
    testDir = mkdtempSync(join(tmpdir(), "review-test-"));
    writeFileSync(
      join(testDir, "system_prompt.md"),
      "You are a code reviewer.",
    );
  });

  function makeDeps(executor: ReviewExecutor): ReviewDeps {
    return {
      db,
      anthropicApiKey: "test-key",
      sendAlert: mock(async (msg: string) => {
        alertMessages.push(msg);
      }),
      executor,
    };
  }

  it("returns structured result on successful review", async () => {
    const executor: ReviewExecutor = mock(async () => ({
      resultText: JSON.stringify({
        verdict: "APPROVE",
        summary: "LGTM",
        findings: [],
      }),
      inputTokens: 500,
      outputTokens: 100,
    }));

    const result = await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "--- a/file.ts\n+++ b/file.ts",
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("APPROVE");
    expect(result!.summary).toBe("LGTM");
  });

  it("logs session to database", async () => {
    const executor: ReviewExecutor = mock(async () => ({
      resultText: JSON.stringify({
        verdict: "APPROVE",
        summary: "ok",
        findings: [],
      }),
      inputTokens: 100,
      outputTokens: 50,
    }));

    await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "diff content",
    );

    const sessions = db
      .prepare("SELECT * FROM sessions WHERE agent = 'reviewer'")
      .all() as { task_id: string; terminal_state: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].task_id).toBe("3.10");
    expect(sessions[0].terminal_state).toBe("complete");
  });

  it("logs usage to cost_log", async () => {
    const executor: ReviewExecutor = mock(async () => ({
      resultText: JSON.stringify({
        verdict: "APPROVE",
        summary: "ok",
        findings: [],
      }),
      inputTokens: 1000,
      outputTokens: 200,
    }));

    await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "diff",
    );

    const costs = db
      .prepare("SELECT * FROM cost_log")
      .all() as { service: string }[];
    expect(costs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null and alerts on executor failure", async () => {
    const executor: ReviewExecutor = mock(async () => {
      throw new Error("API timeout");
    });

    const result = await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "diff",
    );

    expect(result).toBeNull();
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("API timeout");
  });

  it("returns null and alerts on malformed output", async () => {
    const executor: ReviewExecutor = mock(async () => ({
      resultText: "I reviewed the code and it looks fine.",
      inputTokens: 100,
      outputTokens: 50,
    }));

    const result = await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "diff",
    );

    expect(result).toBeNull();
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("No JSON found");
  });

  it("marks session as failed in DB on error", async () => {
    const executor: ReviewExecutor = mock(async () => {
      throw new Error("boom");
    });

    await runCodeReview(
      makeDeps(executor),
      join(testDir, "system_prompt.md"),
      testDir,
      "3.10",
      "diff",
    );

    const sessions = db
      .prepare("SELECT * FROM sessions WHERE agent = 'reviewer'")
      .all() as { terminal_state: string; error: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].terminal_state).toBe("failed");
    expect(sessions[0].error).toBe("boom");
  });
});

// --- Runner integration ---

const PLAN_TEMPLATE = `# Test Plan

### 3.9 -- Test Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none

#### Notes
#### Failure History

---
`;

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-runner-test-"));
  writeFileSync(join(dir, "implementation_plan.md"), PLAN_TEMPLATE);
  writeFileSync(join(dir, "system_prompt.md"), "You are a test agent.");
  return dir;
}

function makeTask(): Task {
  return {
    id: "3.9",
    title: "Test Task",
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

const fakeSandbox: SandboxHandle = {
  sessionId: "sandbox-test",
  workDir: "/tmp/test-workspace",
};

describe("Runner review integration", () => {
  let db: Database;
  let alertMessages: string[];
  let testDir: string;

  beforeEach(() => {
    db = freshDb();
    alertMessages = [];
    testDir = makeTestDir();
  });

  function makeDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
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

  it("task completes when review approves", async () => {
    const deps = makeDeps({
      runReviewFn: mock(
        async (): Promise<ReviewResult> => ({
          verdict: "APPROVE",
          summary: "LGTM",
          findings: [],
        }),
      ),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });

  it("task fails when review requests changes", async () => {
    const deps = makeDeps({
      runReviewFn: mock(
        async (): Promise<ReviewResult> => ({
          verdict: "REQUEST_CHANGES",
          summary: "SQL injection found",
          findings: [
            {
              severity: "critical",
              file: "src/db.ts",
              line: 10,
              description: "Unsanitized input",
            },
          ],
        }),
      ),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(plan).toContain("Code review rejected");

    runner.stop();
  });

  it("task completes when review crashes (soft pass)", async () => {
    const deps = makeDeps({
      runReviewFn: mock(async () => {
        throw new Error("review crashed");
      }),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    // Soft pass: task still completes
    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });

  it("review is not run when coder fails", async () => {
    const reviewFn = mock(async (): Promise<ReviewResult | null> => null);
    const deps = makeDeps({
      executeSessionFn: mock(async (): Promise<AgentOutput> => ({
        sessionId: "test",
        terminalState: "failed",
        artifacts: [],
        usage: { inputTokens: 50, outputTokens: 25 },
        costUsd: 0.005,
        error: "compile error",
      })),
      runReviewFn: reviewFn,
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    expect(reviewFn).not.toHaveBeenCalled();

    runner.stop();
  });

  it("review is skipped when runReviewFn returns null", async () => {
    const deps = makeDeps({
      runReviewFn: mock(async (): Promise<ReviewResult | null> => null),
    });
    const runner = new SessionRunner(deps);
    await runner.runTask(makeTask());

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });
});
