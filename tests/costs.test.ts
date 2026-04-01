import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { PRICING, logUsage, getSessionCost, getDailySpend } from "../src/costs/index.ts";
import type { CostTrackerDeps } from "../src/costs/index.ts";

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

function makeDeps(db: Database): CostTrackerDeps {
  return { db };
}

describe("PRICING", () => {
  it("has pricing for all roster models", () => {
    const models = [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
    ];
    for (const m of models) {
      expect(PRICING[m]).toBeDefined();
      expect(PRICING[m].input).toBeGreaterThan(0);
      expect(PRICING[m].output).toBeGreaterThan(0);
    }
  });

  it("output pricing is higher than input pricing for all models", () => {
    for (const [, p] of Object.entries(PRICING)) {
      expect(p.output).toBeGreaterThan(p.input);
    }
  });
});

describe("logUsage", () => {
  let db: Database;
  let deps: CostTrackerDeps;

  beforeEach(() => {
    db = freshDb();
    deps = makeDeps(db);
  });

  it("calculates cost correctly for claude-opus-4-6", () => {
    // 1000 input * 5.00 + 500 output * 25.00 = 5000 + 12500 = 17500 / 1M = 0.0175
    const cost = logUsage(deps, "s1", "claude-opus-4-6", "anthropic", 1000, 500);
    expect(cost).toBeCloseTo(0.0175, 6);
  });

  it("calculates cost correctly for gemini-3.1-pro-preview", () => {
    // 1000 input * 2.00 + 500 output * 12.00 = 2000 + 6000 = 8000 / 1M = 0.008
    const cost = logUsage(deps, "s1", "gemini-3.1-pro-preview", "google", 1000, 500);
    expect(cost).toBeCloseTo(0.008, 6);
  });

  it("calculates cost correctly for gemini-3.1-flash-lite-preview", () => {
    // 10000 input * 0.25 + 5000 output * 1.50 = 2500 + 7500 = 10000 / 1M = 0.01
    const cost = logUsage(deps, "s1", "gemini-3.1-flash-lite-preview", "google", 10000, 5000);
    expect(cost).toBeCloseTo(0.01, 6);
  });

  it("calculates cost correctly for gpt-5.4-mini", () => {
    // 2000 * 0.75 + 1000 * 4.50 = 1500 + 4500 = 6000 / 1M = 0.006
    const cost = logUsage(deps, "s1", "gpt-5.4-mini", "openai", 2000, 1000);
    expect(cost).toBeCloseTo(0.006, 6);
  });

  it("inserts a row into cost_log", () => {
    logUsage(deps, "s1", "claude-sonnet-4-6", "anthropic", 10000, 5000);
    const rows = db.prepare("SELECT * FROM cost_log").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].service).toBe("anthropic/claude-sonnet-4-6");
    expect(rows[0].amount_usd).toBeGreaterThan(0);
    expect(rows[0].logged_at).toBeTruthy();
  });

  it("returns zero cost for zero tokens", () => {
    const cost = logUsage(deps, "s1", "claude-opus-4-6", "anthropic", 0, 0);
    expect(cost).toBe(0);
  });

  it("throws for unknown model", () => {
    expect(() =>
      logUsage(deps, "s1", "unknown-model", "unknown", 100, 100),
    ).toThrow("No pricing defined for model: unknown-model");
  });
});

describe("getSessionCost", () => {
  let db: Database;
  let deps: CostTrackerDeps;

  beforeEach(() => {
    db = freshDb();
    deps = makeDeps(db);
  });

  it("sums multiple entries for the same session", () => {
    logUsage(deps, "s1", "claude-opus-4-6", "anthropic", 1_000_000, 0);
    logUsage(deps, "s1", "claude-opus-4-6", "anthropic", 0, 1_000_000);
    // 5.00 + 25.00 = 30.00
    const total = getSessionCost(deps, "s1");
    expect(total).toBeCloseTo(30.0, 4);
  });

  it("returns zero for nonexistent session", () => {
    expect(getSessionCost(deps, "nonexistent")).toBe(0);
  });

  it("does not include costs from other sessions", () => {
    logUsage(deps, "s1", "claude-haiku-4-5", "anthropic", 1_000_000, 0);
    logUsage(deps, "s2", "claude-haiku-4-5", "anthropic", 1_000_000, 0);
    const s1Cost = getSessionCost(deps, "s1");
    expect(s1Cost).toBeCloseTo(1.0, 4);
  });
});

describe("getDailySpend", () => {
  let db: Database;
  let deps: CostTrackerDeps;

  beforeEach(() => {
    db = freshDb();
    deps = makeDeps(db);
  });

  it("sums all entries for today when no date given", () => {
    logUsage(deps, "s1", "claude-sonnet-4-6", "anthropic", 1_000_000, 0);
    logUsage(deps, "s2", "gpt-5.4", "openai", 1_000_000, 0);
    // 3.00 + 2.50 = 5.50
    const total = getDailySpend(deps);
    expect(total).toBeCloseTo(5.5, 4);
  });

  it("filters by specific date", () => {
    // Insert with a specific past date
    db.prepare(
      `INSERT INTO cost_log (session_id, service, amount_usd, logged_at)
       VALUES (?, ?, ?, ?)`,
    ).run("s1", "anthropic/claude-opus-4-6", 10.0, "2026-01-15T12:00:00Z");
    db.prepare(
      `INSERT INTO cost_log (session_id, service, amount_usd, logged_at)
       VALUES (?, ?, ?, ?)`,
    ).run("s2", "anthropic/claude-opus-4-6", 5.0, "2026-01-16T12:00:00Z");

    expect(getDailySpend(deps, "2026-01-15")).toBeCloseTo(10.0, 4);
    expect(getDailySpend(deps, "2026-01-16")).toBeCloseTo(5.0, 4);
    expect(getDailySpend(deps, "2026-01-17")).toBe(0);
  });

  it("returns zero when no entries exist", () => {
    expect(getDailySpend(deps, "2026-01-01")).toBe(0);
  });
});
