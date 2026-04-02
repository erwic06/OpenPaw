import { describe, test, expect, beforeEach } from "bun:test";
import {
  initDatabase,
  insertSession,
  getDailySpendByService,
  getMonthlySpendByAgent,
  getMostExpensiveSessions,
} from "../src/db/index.ts";
import type { Database } from "bun:sqlite";

let db: Database;

function addSession(
  id: string,
  agent: string,
  model: string,
  taskId?: string,
): void {
  insertSession(db, {
    id,
    agent,
    task_id: taskId ?? null,
    model,
    provider: "anthropic",
    started_at: new Date().toISOString(),
  });
}

function addCost(
  sessionId: string,
  service: string,
  amount: number,
  date: string,
): void {
  db.prepare(
    `INSERT INTO cost_log (session_id, service, amount_usd, logged_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, service, amount, `${date}T12:00:00Z`);
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

// --- daily_spend_by_service ---

describe("getDailySpendByService", () => {
  test("returns empty array with no data", () => {
    expect(getDailySpendByService(db)).toEqual([]);
  });

  test("returns all days when no date filter", () => {
    addSession("s1", "coder", "claude-sonnet-4-6");
    addCost("s1", "anthropic/claude-sonnet-4-6", 1.5, "2026-04-01");
    addCost("s1", "anthropic/claude-sonnet-4-6", 2.0, "2026-04-02");

    const rows = getDailySpendByService(db);
    expect(rows.length).toBe(2);
    // Ordered by day DESC
    expect(rows[0].day).toBe("2026-04-02");
    expect(rows[0].total).toBe(2.0);
    expect(rows[1].day).toBe("2026-04-01");
    expect(rows[1].total).toBe(1.5);
  });

  test("filters by specific date", () => {
    addSession("s1", "coder", "claude-sonnet-4-6");
    addCost("s1", "anthropic/claude-sonnet-4-6", 1.5, "2026-04-01");
    addCost("s1", "anthropic/claude-sonnet-4-6", 2.0, "2026-04-02");

    const rows = getDailySpendByService(db, "2026-04-01");
    expect(rows.length).toBe(1);
    expect(rows[0].day).toBe("2026-04-01");
    expect(rows[0].total).toBe(1.5);
  });

  test("groups by service", () => {
    addSession("s1", "coder", "claude-sonnet-4-6");
    addSession("s2", "researcher", "gemini-3.1-pro-preview");
    addCost("s1", "anthropic/claude-sonnet-4-6", 1.0, "2026-04-01");
    addCost("s2", "google/gemini-3.1-pro-preview", 2.0, "2026-04-01");

    const rows = getDailySpendByService(db, "2026-04-01");
    expect(rows.length).toBe(2);
    const services = rows.map((r) => r.service).sort();
    expect(services).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3.1-pro-preview",
    ]);
  });
});

// --- monthly_spend_by_agent ---

describe("getMonthlySpendByAgent", () => {
  test("returns empty array with no data", () => {
    expect(getMonthlySpendByAgent(db)).toEqual([]);
  });

  test("returns spend grouped by agent for current month", () => {
    const today = new Date().toISOString().slice(0, 10);
    addSession("s1", "coder", "claude-sonnet-4-6");
    addSession("s2", "researcher", "gemini-3.1-pro-preview");
    addCost("s1", "anthropic/claude-sonnet-4-6", 3.0, today);
    addCost("s2", "google/gemini-3.1-pro-preview", 5.0, today);

    const rows = getMonthlySpendByAgent(db);
    expect(rows.length).toBe(2);
    const coder = rows.find((r) => r.agent === "coder");
    const researcher = rows.find((r) => r.agent === "researcher");
    expect(coder?.total).toBe(3.0);
    expect(researcher?.total).toBe(5.0);
  });

  test("excludes data from previous months", () => {
    addSession("s1", "coder", "claude-sonnet-4-6");
    addCost("s1", "anthropic/claude-sonnet-4-6", 10.0, "2025-01-15");

    const rows = getMonthlySpendByAgent(db);
    expect(rows.length).toBe(0);
  });
});

// --- most_expensive_sessions ---

describe("getMostExpensiveSessions", () => {
  test("returns empty array with no data", () => {
    expect(getMostExpensiveSessions(db)).toEqual([]);
  });

  test("returns sessions ordered by cost DESC", () => {
    addSession("s1", "coder", "claude-sonnet-4-6", "3.1");
    addSession("s2", "coder", "claude-sonnet-4-6", "3.2");
    addSession("s3", "researcher", "gemini-3.1-pro-preview", "R1");
    addCost("s1", "anthropic/claude-sonnet-4-6", 1.0, "2026-04-01");
    addCost("s2", "anthropic/claude-sonnet-4-6", 5.0, "2026-04-01");
    addCost("s3", "google/gemini-3.1-pro-preview", 3.0, "2026-04-01");

    const rows = getMostExpensiveSessions(db);
    expect(rows.length).toBe(3);
    expect(rows[0].id).toBe("s2");
    expect(rows[0].total_cost).toBe(5.0);
    expect(rows[1].id).toBe("s3");
    expect(rows[2].id).toBe("s1");
  });

  test("respects limit parameter", () => {
    addSession("s1", "coder", "claude-sonnet-4-6");
    addSession("s2", "coder", "claude-sonnet-4-6");
    addSession("s3", "coder", "claude-sonnet-4-6");
    addCost("s1", "svc", 1.0, "2026-04-01");
    addCost("s2", "svc", 2.0, "2026-04-01");
    addCost("s3", "svc", 3.0, "2026-04-01");

    const rows = getMostExpensiveSessions(db, 2);
    expect(rows.length).toBe(2);
    expect(rows[0].total_cost).toBe(3.0);
    expect(rows[1].total_cost).toBe(2.0);
  });

  test("default limit is 10", () => {
    for (let i = 0; i < 15; i++) {
      addSession(`s${i}`, "coder", "model");
      addCost(`s${i}`, "svc", i + 1, "2026-04-01");
    }

    const rows = getMostExpensiveSessions(db);
    expect(rows.length).toBe(10);
  });

  test("aggregates multiple cost entries per session", () => {
    addSession("s1", "coder", "claude-sonnet-4-6", "3.1");
    addCost("s1", "svc", 1.0, "2026-04-01");
    addCost("s1", "svc", 2.0, "2026-04-01");
    addCost("s1", "svc", 3.0, "2026-04-01");

    const rows = getMostExpensiveSessions(db);
    expect(rows.length).toBe(1);
    expect(rows[0].total_cost).toBe(6.0);
    expect(rows[0].task_id).toBe("3.1");
  });
});
