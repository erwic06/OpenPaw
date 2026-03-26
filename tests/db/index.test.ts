import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { unlinkSync } from "fs";
import {
  initDatabase,
  insertSession,
  updateSession,
  getSessionsByStatus,
  insertGate,
  updateGate,
  getPendingGates,
  insertCostEntry,
  getDailySpend,
  insertPendingCommunication,
  updatePendingCommunication,
  getPendingCommunications,
} from "../../src/db/index.ts";
import type { Database } from "bun:sqlite";

let db: Database;
let dbPath: string;

beforeEach(async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "db-test-"));
  dbPath = join(tmpDir, "test.db");
  db = initDatabase(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("initDatabase", () => {
  it("creates the database file", () => {
    expect(Bun.file(dbPath).size).toBeGreaterThan(0);
  });

  it("creates all four tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("hitl_gates");
    expect(names).toContain("cost_log");
    expect(names).toContain("pending_communications");
  });

  it("enables WAL mode", () => {
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });

  it("is idempotent -- re-running on existing db causes no errors", () => {
    // Insert data, then re-init
    insertSession(db, {
      id: "s1", agent: "coder", task_id: null, model: "claude-sonnet-4-6",
      provider: "anthropic", started_at: new Date().toISOString(),
    });
    db.close();

    // Re-open and re-init
    db = initDatabase(dbPath);
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
  });
});

describe("sessions", () => {
  it("inserts and queries sessions", () => {
    insertSession(db, {
      id: "s1", agent: "coder", task_id: "2.1", model: "claude-sonnet-4-6",
      provider: "anthropic", started_at: "2026-03-25T10:00:00Z",
    });

    updateSession(db, "s1", {
      ended_at: "2026-03-25T10:05:00Z",
      terminal_state: "COMPLETE",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
    });

    const complete = getSessionsByStatus(db, "COMPLETE");
    expect(complete.length).toBe(1);
    expect(complete[0].id).toBe("s1");
    expect(complete[0].cost_usd).toBe(0.05);
  });
});

describe("hitl_gates", () => {
  it("inserts and resolves gates", () => {
    insertGate(db, {
      id: "g1", gate_type: "plan", task_id: "2.1", session_id: null,
      requested_at: "2026-03-25T10:00:00Z", context_summary: "Approve plan?",
    });

    let pending = getPendingGates(db);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe("g1");

    updateGate(db, "g1", "approved");

    pending = getPendingGates(db);
    expect(pending.length).toBe(0);
  });
});

describe("cost_log", () => {
  it("inserts entries and calculates daily spend", () => {
    insertCostEntry(db, {
      session_id: null, service: "anthropic",
      amount_usd: 0.10, logged_at: "2026-03-25T10:00:00Z",
    });
    insertCostEntry(db, {
      session_id: null, service: "openai",
      amount_usd: 0.25, logged_at: "2026-03-25T14:00:00Z",
    });
    insertCostEntry(db, {
      session_id: null, service: "anthropic",
      amount_usd: 0.50, logged_at: "2026-03-26T10:00:00Z",
    });

    const spend25 = getDailySpend(db, "2026-03-25");
    expect(spend25).toBeCloseTo(0.35, 5);

    const spend26 = getDailySpend(db, "2026-03-26");
    expect(spend26).toBeCloseTo(0.50, 5);
  });
});

describe("pending_communications", () => {
  it("inserts, queries, and updates communications", () => {
    insertPendingCommunication(db, {
      id: "pc1", gate_id: null, agent_id: "social-agent",
      platform: "twitter", recipient: "@user",
      content_type: "text", content: "Hello world",
      metadata: null, created_at: "2026-03-25T10:00:00Z",
    });

    let pending = getPendingCommunications(db);
    expect(pending.length).toBe(1);
    expect(pending[0].content).toBe("Hello world");

    updatePendingCommunication(db, "pc1", "approved_edited", "Hello world!");

    pending = getPendingCommunications(db);
    expect(pending.length).toBe(0);

    const all = db.prepare("SELECT * FROM pending_communications WHERE id = ?").get("pc1") as any;
    expect(all.decision).toBe("approved_edited");
    expect(all.edited_content).toBe("Hello world!");
  });
});
