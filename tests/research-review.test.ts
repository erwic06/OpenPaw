import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runResearchReview, buildResearchReviewPrompt } from "../src/review/research.ts";
import type { ReviewDeps, ReviewExecutor } from "../src/review/index.ts";

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

function makeTmpPrompt(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-review-test-"));
  const promptPath = join(dir, "system-prompt.md");
  writeFileSync(promptPath, "You are a fact-checker.");
  return promptPath;
}

const SAMPLE_BRIEF = `# Research Brief: Test Topic

## Executive Summary
Some claims here.

## Section 1: Findings
**Confidence: high**
Something was found [1].

## Sources
[1] Source Title — https://example.com — Accessed 2026-04-01
`;

describe("buildResearchReviewPrompt", () => {
  it("includes the task ID", () => {
    const prompt = buildResearchReviewPrompt("R.1", SAMPLE_BRIEF);
    expect(prompt).toContain("R.1");
  });

  it("includes the brief content in a markdown fence", () => {
    const prompt = buildResearchReviewPrompt("R.1", SAMPLE_BRIEF);
    expect(prompt).toContain("```markdown");
    expect(prompt).toContain("Research Brief: Test Topic");
  });

  it("requests JSON-only output", () => {
    const prompt = buildResearchReviewPrompt("R.1", SAMPLE_BRIEF);
    expect(prompt).toContain("ONLY a JSON object");
  });
});

describe("runResearchReview", () => {
  let db: Database;
  let alerts: string[];
  let promptPath: string;

  beforeEach(() => {
    db = freshDb();
    alerts = [];
    promptPath = makeTmpPrompt();
  });

  function makeDeps(executor: ReviewExecutor): ReviewDeps {
    return {
      db,
      anthropicApiKey: "test-key",
      sendAlert: async (msg: string) => { alerts.push(msg); },
      executor,
    };
  }

  it("returns APPROVE result on successful review", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: JSON.stringify({
        verdict: "APPROVE",
        summary: "Research looks solid",
        findings: [],
      }),
      inputTokens: 500,
      outputTokens: 100,
    });

    const result = await runResearchReview(
      makeDeps(executor), promptPath, "/tmp", "R.1", SAMPLE_BRIEF,
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("APPROVE");
    expect(result!.summary).toBe("Research looks solid");
    expect(result!.findings).toEqual([]);
  });

  it("returns REQUEST_CHANGES with findings", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: JSON.stringify({
        verdict: "REQUEST_CHANGES",
        summary: "Found fabricated claim",
        findings: [
          {
            severity: "critical",
            file: "Section 1: Findings",
            line: 0,
            description: "Claim X has no supporting evidence in cited source",
          },
        ],
      }),
      inputTokens: 500,
      outputTokens: 200,
    });

    const result = await runResearchReview(
      makeDeps(executor), promptPath, "/tmp", "R.2", SAMPLE_BRIEF,
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("REQUEST_CHANGES");
    expect(result!.findings.length).toBe(1);
    expect(result!.findings[0].severity).toBe("critical");
  });

  it("inserts and updates session record", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: JSON.stringify({ verdict: "APPROVE", summary: "OK", findings: [] }),
      inputTokens: 100,
      outputTokens: 50,
    });

    await runResearchReview(makeDeps(executor), promptPath, "/tmp", "R.3", SAMPLE_BRIEF);

    const sessions = db.query("SELECT * FROM sessions WHERE agent = 'researcher-reviewer'").all() as any[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].model).toBe("claude-sonnet-4-6");
    expect(sessions[0].provider).toBe("anthropic");
    expect(sessions[0].terminal_state).toBe("complete");
    expect(sessions[0].ended_at).not.toBeNull();
  });

  it("logs cost to database", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: JSON.stringify({ verdict: "APPROVE", summary: "OK", findings: [] }),
      inputTokens: 1000,
      outputTokens: 500,
    });

    await runResearchReview(makeDeps(executor), promptPath, "/tmp", "R.4", SAMPLE_BRIEF);

    const costRows = db.query("SELECT * FROM cost_log").all() as any[];
    expect(costRows.length).toBe(1);
    expect(costRows[0].service).toBe("anthropic/claude-sonnet-4-6");
    expect(costRows[0].amount_usd).toBeGreaterThan(0);
  });

  it("returns null on executor failure (soft pass)", async () => {
    const executor: ReviewExecutor = async () => {
      throw new Error("SDK connection failed");
    };

    const result = await runResearchReview(
      makeDeps(executor), promptPath, "/tmp", "R.5", SAMPLE_BRIEF,
    );

    expect(result).toBeNull();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("R.5");
    expect(alerts[0]).toContain("SDK connection failed");
  });

  it("returns null on malformed JSON output (soft pass)", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: "This is not JSON at all",
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await runResearchReview(
      makeDeps(executor), promptPath, "/tmp", "R.6", SAMPLE_BRIEF,
    );

    expect(result).toBeNull();
    expect(alerts.length).toBe(1);
  });

  it("updates session to failed on error", async () => {
    const executor: ReviewExecutor = async () => {
      throw new Error("timeout");
    };

    await runResearchReview(makeDeps(executor), promptPath, "/tmp", "R.7", SAMPLE_BRIEF);

    const sessions = db.query("SELECT * FROM sessions WHERE agent = 'researcher-reviewer'").all() as any[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].terminal_state).toBe("failed");
    expect(sessions[0].error).toBe("timeout");
  });

  it("handles code-fenced JSON in executor output", async () => {
    const executor: ReviewExecutor = async () => ({
      resultText: "```json\n" + JSON.stringify({
        verdict: "APPROVE",
        summary: "All good",
        findings: [],
      }) + "\n```",
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await runResearchReview(
      makeDeps(executor), promptPath, "/tmp", "R.8", SAMPLE_BRIEF,
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("APPROVE");
  });
});
