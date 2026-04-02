import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ResearchRunner, assembleBriefContext } from "../src/research/runner.ts";
import type { ResearchRunnerDeps } from "../src/research/runner.ts";
import type { Task } from "../src/plan/types.ts";
import type { AgentOutput } from "../src/agents/types.ts";
import type { ReviewResult } from "../src/review/types.ts";
import type { GateResult } from "../src/gates/types.ts";
import type { CostEstimate } from "../src/research/estimator.ts";

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

### R1 -- Research Task
- **Status:** ready
- **Type:** research
- **Contract:** contracts/test-research.md
- **Dependencies:** none

#### Notes
#### Failure History

---
`;

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-runner-test-"));
  writeFileSync(join(dir, "implementation_plan.md"), PLAN_TEMPLATE);
  writeFileSync(join(dir, "system_prompt.md"), "You are a researcher.");
  writeFileSync(join(dir, "reviewer_prompt.md"), "You are a fact-checker.");
  return dir;
}

function makeTask(id = "R1", title = "Research Task"): Task {
  return {
    id,
    title,
    status: "ready",
    type: "research",
    contract: "contracts/test-research.md",
    dependencies: [],
    assigned: "interactive",
    artifacts: [],
    acceptance: "Brief produced",
    notes: [],
  };
}

function successOutput(sessionId = "test-session"): AgentOutput {
  return {
    sessionId,
    terminalState: "complete",
    artifacts: [],
    usage: { inputTokens: 5000, outputTokens: 3000 },
    costUsd: 0.45,
    error: null,
  };
}

function failedOutput(error: string): AgentOutput {
  return {
    sessionId: "test-session",
    terminalState: "failed",
    artifacts: [],
    usage: { inputTokens: 100, outputTokens: 0 },
    costUsd: 0.01,
    error,
  };
}

function approveGate(gateType?: string): GateResult {
  return {
    gateId: `gate-test-${gateType ?? "generic"}`,
    decision: "approved",
    feedback: [],
    decidedAt: new Date().toISOString(),
  };
}

function denyGate(gateType?: string): GateResult {
  return {
    gateId: `gate-test-${gateType ?? "generic"}`,
    decision: "denied",
    feedback: [],
    decidedAt: new Date().toISOString(),
  };
}

function timeoutGate(): GateResult {
  return {
    gateId: "gate-test-timeout",
    decision: "timeout",
    feedback: [],
    decidedAt: new Date().toISOString(),
  };
}

function approveReview(): ReviewResult {
  return {
    verdict: "APPROVE",
    summary: "Brief looks good",
    findings: [],
  };
}

function rejectReview(summary = "Unsupported claims"): ReviewResult {
  return {
    verdict: "REQUEST_CHANGES",
    summary,
    findings: [
      { severity: "critical", file: "", line: 0, description: "Fabricated claim in section 2" },
    ],
  };
}

const SAMPLE_BRIEF = `# Research Brief: Test Topic

## Executive Summary
This is a test brief.

## Analysis
Some analysis here. **Confidence: high**

## Sources
[1] Test Source — https://example.com — Accessed 2026-04-01`;

const ESTIMATE: CostEstimate = {
  depth: 5,
  estimatedTokens: 12000,
  estimatedCostRange: [0.50, 1.00],
};

let db: Database;
let alertMessages: string[];
let testDir: string;
let gateRequests: Array<{ gateType: string; taskId: string | null }>;

function makeDeps(overrides?: Partial<ResearchRunnerDeps>): ResearchRunnerDeps {
  gateRequests = [];
  return {
    db,
    sendAlert: mock(async (msg: string) => {
      alertMessages.push(msg);
    }),
    geminiApiKey: "test-gemini-key",
    anthropicApiKey: "test-anthropic-key",
    browserUseDeps: { cloudApiKey: "test-browseruse-key" },
    planPath: join(testDir, "implementation_plan.md"),
    systemPromptPath: join(testDir, "system_prompt.md"),
    reviewerPromptPath: join(testDir, "reviewer_prompt.md"),
    estimateCostFn: mock(() => ESTIMATE),
    executeResearchFn: mock(async () => ({
      output: successOutput(),
      briefText: SAMPLE_BRIEF,
    })),
    runReviewFn: mock(async () => approveReview()),
    requestApprovalFn: mock(async (req) => {
      gateRequests.push({ gateType: req.gateType, taskId: req.taskId });
      return approveGate(req.gateType);
    }),
    ...overrides,
  };
}

beforeEach(() => {
  db = freshDb();
  alertMessages = [];
  testDir = makeTestDir();
});

// --- Full lifecycle ---

describe("ResearchRunner.runResearch", () => {
  it("executes full success lifecycle", async () => {
    const deps = makeDeps();
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test prompt");

    // Plan updated to complete
    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    // Both gates fired: spend + research
    expect(gateRequests.length).toBe(2);
    expect(gateRequests[0].gateType).toBe("spend");
    expect(gateRequests[1].gateType).toBe("research");

    // Completion alert sent
    expect(alertMessages.some((m) => m.includes("complete"))).toBe(true);
    expect(alertMessages.some((m) => m.includes("$0.4500"))).toBe(true);

    runner.stop();
  });

  it("marks task in-progress after cost approval", async () => {
    let statusDuringExecution = "";
    const deps = makeDeps({
      executeResearchFn: mock(async () => {
        statusDuringExecution = readFileSync(
          join(testDir, "implementation_plan.md"),
          "utf-8",
        );
        return { output: successOutput(), briefText: SAMPLE_BRIEF };
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    expect(statusDuringExecution).toContain("- **Status:** in-progress");

    runner.stop();
  });
});

// --- Cost estimate denied ---

describe("cost estimate denied", () => {
  it("blocks task when cost denied", async () => {
    const deps = makeDeps({
      requestApprovalFn: mock(async (req) => {
        gateRequests.push({ gateType: req.gateType, taskId: req.taskId });
        return denyGate(req.gateType);
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** blocked");

    // Only spend gate fired (no research gate)
    expect(gateRequests.length).toBe(1);
    expect(gateRequests[0].gateType).toBe("spend");

    // No research session executed
    expect(deps.executeResearchFn).not.toHaveBeenCalled();

    runner.stop();
  });

  it("sends alert when cost denied", async () => {
    const deps = makeDeps({
      requestApprovalFn: mock(async () => denyGate("spend")),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    expect(alertMessages.some((m) => m.includes("cost estimate denied"))).toBe(true);

    runner.stop();
  });
});

// --- Research session failure ---

describe("research session failure", () => {
  it("marks task failed when session fails", async () => {
    const deps = makeDeps({
      executeResearchFn: mock(async () => ({
        output: failedOutput("Gemini API error"),
        briefText: "",
      })),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(plan).toContain("Gemini API error");

    // No review or gate 3 triggered
    expect(deps.runReviewFn).not.toHaveBeenCalled();
    expect(gateRequests.length).toBe(1); // Only spend gate

    runner.stop();
  });

  it("marks task failed when brief is empty", async () => {
    const deps = makeDeps({
      executeResearchFn: mock(async () => ({
        output: successOutput(),
        briefText: "   ",
      })),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(plan).toContain("no output");

    runner.stop();
  });
});

// --- Reviewer rejection ---

describe("reviewer rejection", () => {
  it("marks task failed when reviewer rejects", async () => {
    const deps = makeDeps({
      runReviewFn: mock(async () => rejectReview("Claims not supported")),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(plan).toContain("Fact-check rejected");

    // No research gate fired
    expect(gateRequests.length).toBe(1); // Only spend gate

    runner.stop();
  });

  it("sends alert with rejection summary", async () => {
    const deps = makeDeps({
      runReviewFn: mock(async () => rejectReview("Fabricated statistics")),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    expect(alertMessages.some((m) => m.includes("Fabricated statistics"))).toBe(true);

    runner.stop();
  });
});

// --- Gate 3 outcomes ---

describe("Gate 3 (research brief approval)", () => {
  it("completes task on gate approval", async () => {
    const deps = makeDeps();
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });

  it("blocks task on gate denial", async () => {
    let gateCount = 0;
    const deps = makeDeps({
      requestApprovalFn: mock(async (req) => {
        gateRequests.push({ gateType: req.gateType, taskId: req.taskId });
        gateCount++;
        // Approve spend gate, deny research gate
        if (gateCount === 1) return approveGate("spend");
        return denyGate("research");
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** blocked");
    expect(plan).toContain("Research brief denied");

    runner.stop();
  });

  it("blocks task on gate timeout", async () => {
    let gateCount = 0;
    const deps = makeDeps({
      requestApprovalFn: mock(async (req) => {
        gateRequests.push({ gateType: req.gateType, taskId: req.taskId });
        gateCount++;
        if (gateCount === 1) return approveGate("spend");
        return timeoutGate();
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** blocked");
    expect(plan).toContain("Research brief timeout");

    runner.stop();
  });

  it("fires gate with brief context summary", async () => {
    let researchGateContext = "";
    let gateCount = 0;
    const deps = makeDeps({
      requestApprovalFn: mock(async (req) => {
        gateRequests.push({ gateType: req.gateType, taskId: req.taskId });
        gateCount++;
        if (req.gateType === "research") {
          researchGateContext = req.contextSummary;
        }
        return approveGate(req.gateType);
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    expect(researchGateContext).toContain("R1");
    expect(researchGateContext).toContain("Brief Preview");
    expect(researchGateContext).toContain("Research Brief: Test Topic");

    runner.stop();
  });
});

// --- Review soft pass ---

describe("review soft pass", () => {
  it("proceeds to gate when review returns null", async () => {
    const deps = makeDeps({
      runReviewFn: mock(async () => null),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    // Research gate still fires
    expect(gateRequests.length).toBe(2);
    expect(gateRequests[1].gateType).toBe("research");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** complete");

    runner.stop();
  });
});

// --- Exception handling ---

describe("exception handling", () => {
  it("marks task failed on unexpected error", async () => {
    const deps = makeDeps({
      executeResearchFn: mock(async () => {
        throw new Error("unexpected crash");
      }),
    });
    const runner = new ResearchRunner(deps);
    await runner.runResearch(makeTask(), 5, "test");

    const plan = readFileSync(deps.planPath, "utf-8");
    expect(plan).toContain("- **Status:** failed");
    expect(alertMessages.some((m) => m.includes("unexpected crash"))).toBe(true);

    runner.stop();
  });
});

// --- assembleBriefContext ---

describe("assembleBriefContext", () => {
  it("includes task info, cost, and brief preview", () => {
    const ctx = assembleBriefContext(
      makeTask(),
      successOutput(),
      approveReview(),
      SAMPLE_BRIEF,
    );
    expect(ctx).toContain("R1");
    expect(ctx).toContain("$0.4500");
    expect(ctx).toContain("5000 in / 3000 out");
    expect(ctx).toContain("Fact-Check Review");
    expect(ctx).toContain("APPROVE");
    expect(ctx).toContain("Brief Preview");
  });

  it("truncates long briefs", () => {
    const longBrief = "x".repeat(5000);
    const ctx = assembleBriefContext(makeTask(), successOutput(), null, longBrief);
    expect(ctx).toContain("5000 chars total");
    expect(ctx.length).toBeLessThan(5000);
  });

  it("includes findings when present", () => {
    const review = rejectReview("Bad claims");
    const ctx = assembleBriefContext(makeTask(), successOutput(), review, SAMPLE_BRIEF);
    expect(ctx).toContain("REQUEST_CHANGES");
    expect(ctx).toContain("Fabricated claim");
  });

  it("omits review section when null", () => {
    const ctx = assembleBriefContext(makeTask(), successOutput(), null, SAMPLE_BRIEF);
    expect(ctx).not.toContain("Fact-Check Review");
  });
});

// --- stop ---

describe("ResearchRunner.stop", () => {
  it("stops without error", () => {
    const deps = makeDeps();
    const runner = new ResearchRunner(deps);
    runner.stop();
  });

  it("double stop is safe", () => {
    const deps = makeDeps();
    const runner = new ResearchRunner(deps);
    runner.stop();
    runner.stop();
  });
});
