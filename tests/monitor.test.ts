import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { SessionMonitor } from "../src/agents/monitor.ts";
import type { MonitorDeps } from "../src/agents/monitor.ts";

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

function insertTestSession(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, task_id, model, provider, started_at)
     VALUES (?, 'coder', '3.8', 'claude-sonnet-4-6', 'anthropic', ?)`,
  ).run(id, new Date().toISOString());
}

let db: Database;
let currentTime: number;
let cancelCalls: string[];
let alertMessages: string[];
let deps: MonitorDeps;

beforeEach(() => {
  db = freshDb();
  currentTime = 1000000;
  cancelCalls = [];
  alertMessages = [];
  deps = {
    cancelSession: mock(async (id: string) => {
      cancelCalls.push(id);
    }),
    db,
    sendAlert: mock(async (msg: string) => {
      alertMessages.push(msg);
    }),
    now: () => currentTime,
  };
});

describe("SessionMonitor.startMonitoring / stopMonitoring", () => {
  it("tracks a session after startMonitoring", () => {
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");
    expect(monitor.getTrackedSessions()).toEqual(["s1"]);
  });

  it("removes a session after stopMonitoring", () => {
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");
    monitor.stopMonitoring("s1");
    expect(monitor.getTrackedSessions()).toEqual([]);
  });

  it("stopMonitoring on unknown session is a no-op", () => {
    const monitor = new SessionMonitor(deps);
    monitor.stopMonitoring("nonexistent");
    expect(monitor.getTrackedSessions()).toEqual([]);
  });
});

describe("SessionMonitor.recordActivity", () => {
  it("updates last activity timestamp", async () => {
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    // Advance time by 5 minutes
    currentTime += 5 * 60 * 1000;
    monitor.recordActivity("s1");

    // Advance another 6 minutes (total 11 from start, but only 6 from last activity)
    currentTime += 6 * 60 * 1000;
    await monitor.check();

    // Should NOT be detected as hung (only 6 min since last activity)
    expect(cancelCalls).toHaveLength(0);
  });

  it("ignores recordActivity for untracked sessions", () => {
    const monitor = new SessionMonitor(deps);
    monitor.recordActivity("unknown");
    expect(monitor.getTrackedSessions()).toEqual([]);
  });
});

describe("SessionMonitor.check", () => {
  it("detects hung sessions after 10 minutes of inactivity", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    // Advance 11 minutes
    currentTime += 11 * 60 * 1000;
    await monitor.check();

    expect(cancelCalls).toEqual(["s1"]);
  });

  it("does not flag sessions within 10 minute threshold", async () => {
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    // Advance 9 minutes
    currentTime += 9 * 60 * 1000;
    await monitor.check();

    expect(cancelCalls).toHaveLength(0);
    expect(alertMessages).toHaveLength(0);
  });

  it("cancels hung session via cancelSession dep", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();

    expect(cancelCalls).toEqual(["s1"]);
  });

  it("updates SQLite session record to FAILED", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1") as any;
    expect(row.terminal_state).toBe("failed");
    expect(row.error).toBe("Session hung -- no output for 10 minutes");
    expect(row.ended_at).toBeDefined();
  });

  it("sends Telegram alert for hung sessions", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();

    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("s1");
    expect(alertMessages[0]).toContain("hung");
    expect(alertMessages[0]).toContain("FAILED");
  });

  it("removes hung session from tracking after handling", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();

    expect(monitor.getTrackedSessions()).toEqual([]);
  });

  it("handles multiple sessions independently", async () => {
    insertTestSession(db, "s1");
    insertTestSession(db, "s2");
    const monitor = new SessionMonitor(deps);

    monitor.startMonitoring("s1");
    currentTime += 5 * 60 * 1000;
    monitor.startMonitoring("s2");

    // 6 more minutes: s1 at 11min (hung), s2 at 6min (ok)
    currentTime += 6 * 60 * 1000;
    await monitor.check();

    expect(cancelCalls).toEqual(["s1"]);
    expect(monitor.getTrackedSessions()).toEqual(["s2"]);
  });

  it("does not double-handle a hung session on repeated checks", async () => {
    insertTestSession(db, "s1");
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();
    await monitor.check(); // second check

    expect(cancelCalls).toEqual(["s1"]); // only once
    expect(alertMessages).toHaveLength(1);
  });

  it("handles cancelSession throwing gracefully", async () => {
    insertTestSession(db, "s1");
    deps.cancelSession = mock(async () => {
      throw new Error("session already finished");
    });
    const monitor = new SessionMonitor(deps);
    monitor.startMonitoring("s1");

    currentTime += 11 * 60 * 1000;
    await monitor.check();

    // Should still update DB and send alert despite cancel error
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1") as any;
    expect(row.terminal_state).toBe("failed");
    expect(alertMessages).toHaveLength(1);
  });
});

describe("SessionMonitor.start / stop", () => {
  it("start and stop do not throw", () => {
    const monitor = new SessionMonitor(deps);
    monitor.start();
    monitor.stop();
  });

  it("double start is a no-op", () => {
    const monitor = new SessionMonitor(deps);
    monitor.start();
    monitor.start(); // should not create a second interval
    monitor.stop();
  });

  it("stop without start is a no-op", () => {
    const monitor = new SessionMonitor(deps);
    monitor.stop(); // should not throw
  });
});
