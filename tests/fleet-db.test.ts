import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDatabase,
  insertAgentDefinition,
  updateAgentDefinition,
  getAgentDefinition,
  getAllAgentDefinitions,
  getEnabledAgentDefinitions,
  setAgentEnabled,
  updateAgentLastRun,
  updateAgentNextRun,
  insertAgentRun,
  updateAgentRun,
  getAgentRunsByAgent,
  getLatestAgentRun,
  insertSession,
} from "../src/db/index.ts";
import type { AgentDefinitionRow, AgentRunRow } from "../src/db/types.ts";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

describe("agent_definitions CRUD", () => {
  function insertTestDef(overrides: Partial<Omit<AgentDefinitionRow, "created_at" | "last_run_at">> = {}) {
    const def = {
      id: "test-agent",
      name: "Test Agent",
      config_path: "agents/test-agent/agent.md",
      schedule_type: "cron" as string | null,
      schedule_expression: "0 20 * * *" as string | null,
      enabled: 1,
      next_run_at: "2026-04-02T20:00:00.000Z" as string | null,
      ...overrides,
    };
    insertAgentDefinition(db, def);
    return def;
  }

  test("insertAgentDefinition creates a row", () => {
    insertTestDef();
    const row = getAgentDefinition(db, "test-agent");
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Test Agent");
    expect(row!.config_path).toBe("agents/test-agent/agent.md");
    expect(row!.schedule_type).toBe("cron");
    expect(row!.schedule_expression).toBe("0 20 * * *");
    expect(row!.enabled).toBe(1);
    expect(row!.next_run_at).toBe("2026-04-02T20:00:00.000Z");
    expect(row!.created_at).toBeTruthy();
    expect(row!.last_run_at).toBeNull();
  });

  test("insertAgentDefinition with null schedule", () => {
    insertTestDef({ id: "manual-agent", schedule_type: null, schedule_expression: null, next_run_at: null });
    const row = getAgentDefinition(db, "manual-agent");
    expect(row!.schedule_type).toBeNull();
    expect(row!.schedule_expression).toBeNull();
    expect(row!.next_run_at).toBeNull();
  });

  test("updateAgentDefinition modifies fields", () => {
    insertTestDef();
    updateAgentDefinition(db, "test-agent", { name: "Updated Agent", enabled: 0 });
    const row = getAgentDefinition(db, "test-agent");
    expect(row!.name).toBe("Updated Agent");
    expect(row!.enabled).toBe(0);
  });

  test("updateAgentDefinition with no fields is no-op", () => {
    insertTestDef();
    updateAgentDefinition(db, "test-agent", {});
    const row = getAgentDefinition(db, "test-agent");
    expect(row!.name).toBe("Test Agent");
  });

  test("getAgentDefinition returns null for missing ID", () => {
    const row = getAgentDefinition(db, "nonexistent");
    expect(row).toBeNull();
  });

  test("getAllAgentDefinitions returns all sorted by name", () => {
    insertTestDef({ id: "z-agent", name: "Z Agent" });
    insertTestDef({ id: "a-agent", name: "A Agent" });
    const all = getAllAgentDefinitions(db);
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("A Agent");
    expect(all[1].name).toBe("Z Agent");
  });

  test("getEnabledAgentDefinitions filters disabled agents", () => {
    insertTestDef({ id: "enabled-agent", name: "Enabled", enabled: 1 });
    insertTestDef({ id: "disabled-agent", name: "Disabled", enabled: 0 });
    const enabled = getEnabledAgentDefinitions(db);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe("enabled-agent");
  });

  test("setAgentEnabled toggles enabled flag", () => {
    insertTestDef();
    expect(getAgentDefinition(db, "test-agent")!.enabled).toBe(1);

    setAgentEnabled(db, "test-agent", false);
    expect(getAgentDefinition(db, "test-agent")!.enabled).toBe(0);

    setAgentEnabled(db, "test-agent", true);
    expect(getAgentDefinition(db, "test-agent")!.enabled).toBe(1);
  });

  test("updateAgentLastRun sets timestamp", () => {
    insertTestDef();
    const ts = "2026-04-02T20:05:00.000Z";
    updateAgentLastRun(db, "test-agent", ts);
    expect(getAgentDefinition(db, "test-agent")!.last_run_at).toBe(ts);
  });

  test("updateAgentNextRun sets or clears timestamp", () => {
    insertTestDef();
    const ts = "2026-04-03T20:00:00.000Z";
    updateAgentNextRun(db, "test-agent", ts);
    expect(getAgentDefinition(db, "test-agent")!.next_run_at).toBe(ts);

    updateAgentNextRun(db, "test-agent", null);
    expect(getAgentDefinition(db, "test-agent")!.next_run_at).toBeNull();
  });
});

describe("agent_runs CRUD", () => {
  beforeEach(() => {
    // Insert a definition for FK
    insertAgentDefinition(db, {
      id: "test-agent",
      name: "Test Agent",
      config_path: "agents/test-agent/agent.md",
      schedule_type: "cron",
      schedule_expression: "0 20 * * *",
      enabled: 1,
      next_run_at: null,
    });
  });

  function insertTestRun(overrides: Partial<Omit<AgentRunRow, "ended_at" | "status" | "output_routed_to">> = {}) {
    const run = {
      id: "run-test-1",
      agent_id: "test-agent",
      session_id: null as string | null,
      triggered_by: "schedule",
      trigger_detail: "0 20 * * *",
      started_at: "2026-04-02T20:00:00.000Z",
      ...overrides,
    };
    insertAgentRun(db, run);
    return run;
  }

  test("insertAgentRun creates a row", () => {
    insertTestRun();
    const runs = getAgentRunsByAgent(db, "test-agent");
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("run-test-1");
    expect(runs[0].agent_id).toBe("test-agent");
    expect(runs[0].triggered_by).toBe("schedule");
    expect(runs[0].trigger_detail).toBe("0 20 * * *");
    expect(runs[0].ended_at).toBeNull();
    expect(runs[0].status).toBeNull();
    expect(runs[0].output_routed_to).toBeNull();
  });

  test("insertAgentRun with session_id FK", () => {
    insertSession(db, {
      id: "session-abc",
      agent: "custom",
      task_id: null,
      model: "gemini-3.1-pro",
      provider: "google",
      started_at: "2026-04-02T20:00:00.000Z",
    });
    insertTestRun({ id: "run-with-session", session_id: "session-abc" });
    const runs = getAgentRunsByAgent(db, "test-agent");
    expect(runs[0].session_id).toBe("session-abc");
  });

  test("updateAgentRun modifies fields", () => {
    insertTestRun();
    updateAgentRun(db, "run-test-1", {
      ended_at: "2026-04-02T20:05:00.000Z",
      status: "complete",
      output_routed_to: '["telegram","github"]',
    });
    const runs = getAgentRunsByAgent(db, "test-agent");
    expect(runs[0].status).toBe("complete");
    expect(runs[0].ended_at).toBe("2026-04-02T20:05:00.000Z");
    expect(runs[0].output_routed_to).toBe('["telegram","github"]');
  });

  test("updateAgentRun with no fields is no-op", () => {
    insertTestRun();
    updateAgentRun(db, "run-test-1", {});
    const runs = getAgentRunsByAgent(db, "test-agent");
    expect(runs[0].status).toBeNull();
  });

  test("getAgentRunsByAgent returns ordered by started_at DESC", () => {
    insertTestRun({ id: "run-old", started_at: "2026-04-01T20:00:00.000Z" });
    insertTestRun({ id: "run-new", started_at: "2026-04-02T20:00:00.000Z" });
    const runs = getAgentRunsByAgent(db, "test-agent");
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe("run-new");
    expect(runs[1].id).toBe("run-old");
  });

  test("getAgentRunsByAgent respects limit", () => {
    insertTestRun({ id: "run-1", started_at: "2026-04-01T20:00:00.000Z" });
    insertTestRun({ id: "run-2", started_at: "2026-04-02T20:00:00.000Z" });
    insertTestRun({ id: "run-3", started_at: "2026-04-03T20:00:00.000Z" });
    const runs = getAgentRunsByAgent(db, "test-agent", 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe("run-3");
  });

  test("getLatestAgentRun returns most recent", () => {
    insertTestRun({ id: "run-old", started_at: "2026-04-01T20:00:00.000Z" });
    insertTestRun({ id: "run-new", started_at: "2026-04-02T20:00:00.000Z" });
    const latest = getLatestAgentRun(db, "test-agent");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("run-new");
  });

  test("getLatestAgentRun returns null for agent with no runs", () => {
    const latest = getLatestAgentRun(db, "test-agent");
    expect(latest).toBeNull();
  });

  test("getAgentRunsByAgent returns empty for unknown agent", () => {
    const runs = getAgentRunsByAgent(db, "nonexistent");
    expect(runs).toHaveLength(0);
  });
});
