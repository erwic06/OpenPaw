import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { CronScheduler } from "../src/fleet/scheduler.ts";
import type { SchedulerDeps } from "../src/fleet/scheduler.ts";
import type { AgentDefinition } from "../src/fleet/types.ts";
import {
  insertAgentDefinition,
  getAgentDefinition,
  updateAgentLastRun,
} from "../src/db/index.ts";

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

function makeDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "test-agent",
    name: "Test Agent",
    configPath: "agents/test-agent/agent.md",
    agentType: "custom",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    description: "",
    schedule: { type: "cron", expression: "0 20 * * *" },
    tools: [],
    input: "",
    outputDestinations: [],
    depth: null,
    budgetPerRun: 1.0,
    adapterConfig: { type: "llm" },
    enabled: true,
    ...overrides,
  };
}

let db: Database;

beforeEach(() => {
  db = freshDb();
});

describe("CronScheduler", () => {
  test("triggers agent when cron matches", async () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    const triggered: string[] = [];
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async (d, _by, _detail) => {
        triggered.push(d.id);
      },
      now: () => new Date("2026-04-02T20:00:00"),
    });

    scheduler.updateSchedule([def]);
    scheduler.start();

    // Wait for the initial tick
    await new Promise((r) => setTimeout(r, 100));

    expect(triggered).toContain("test-agent");

    scheduler.stop();
  });

  test("does not trigger when cron does not match", async () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    const triggered: string[] = [];
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async (d) => {
        triggered.push(d.id);
      },
      now: () => new Date("2026-04-02T19:00:00"),
    });

    scheduler.updateSchedule([def]);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(triggered).toHaveLength(0);

    scheduler.stop();
  });

  test("idempotent: skips if already ran in same cron minute", async () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    // Pre-set last_run_at to the current cron minute
    updateAgentLastRun(db, def.id, "2026-04-02T20:00:30.000Z");

    const triggered: string[] = [];
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async (d) => {
        triggered.push(d.id);
      },
      now: () => new Date("2026-04-02T20:00:45"),
    });

    scheduler.updateSchedule([def]);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(triggered).toHaveLength(0);

    scheduler.stop();
  });

  test("updates last_run_at and next_run_at on trigger", async () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    const scheduler = new CronScheduler({
      db,
      triggerAgent: async () => {},
      now: () => new Date("2026-04-02T20:00:00"),
    });

    scheduler.updateSchedule([def]);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));

    const row = getAgentDefinition(db, def.id);
    expect(row!.last_run_at).toBeTruthy();
    expect(row!.next_run_at).toBeTruthy();

    // next_run_at should be tomorrow at 20:00
    const nextRun = new Date(row!.next_run_at!);
    expect(nextRun.getHours()).toBe(20);
    expect(nextRun.getMinutes()).toBe(0);

    scheduler.stop();
  });

  test("triggerManual triggers immediately", async () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    const triggered: { id: string; by: string }[] = [];
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async (d, by) => {
        triggered.push({ id: d.id, by });
      },
      now: () => new Date("2026-04-02T12:00:00"), // Not cron time
    });

    scheduler.updateSchedule([def]);
    await scheduler.triggerManual("test-agent");

    expect(triggered).toEqual([{ id: "test-agent", by: "manual" }]);

    const row = getAgentDefinition(db, def.id);
    expect(row!.last_run_at).toBeTruthy();
  });

  test("triggerManual throws for unknown agent", async () => {
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async () => {},
    });

    expect(scheduler.triggerManual("nonexistent")).rejects.toThrow("not found");
  });

  test("stop() clears interval", () => {
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async () => {},
    });

    scheduler.start();
    scheduler.stop();
    scheduler.stop(); // idempotent
  });

  test("updateSchedule computes next_run_at for cron definitions", () => {
    const def = makeDef();
    insertAgentDefinition(db, {
      id: def.id,
      name: def.name,
      config_path: def.configPath,
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });

    const scheduler = new CronScheduler({
      db,
      triggerAgent: async () => {},
      now: () => new Date("2026-04-02T15:00:00"),
    });

    scheduler.updateSchedule([def]);

    const row = getAgentDefinition(db, def.id);
    expect(row!.next_run_at).toBeTruthy();
    const nextRun = new Date(row!.next_run_at!);
    expect(nextRun.getHours()).toBe(20);
  });

  test("handles multiple cron agents in single tick", async () => {
    const def1 = makeDef({ id: "agent-1", name: "Agent 1" });
    const def2 = makeDef({
      id: "agent-2",
      name: "Agent 2",
      schedule: { type: "cron", expression: "0 20 * * *" },
    });

    for (const def of [def1, def2]) {
      insertAgentDefinition(db, {
        id: def.id,
        name: def.name,
        config_path: def.configPath,
        schedule_type: "cron",
        schedule_expression: "0 20 * * *",
        enabled: 1,
        next_run_at: null,
      });
    }

    const triggered: string[] = [];
    const scheduler = new CronScheduler({
      db,
      triggerAgent: async (d) => {
        triggered.push(d.id);
      },
      now: () => new Date("2026-04-02T20:00:00"),
    });

    scheduler.updateSchedule([def1, def2]);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(triggered.sort()).toEqual(["agent-1", "agent-2"]);

    scheduler.stop();
  });
});
