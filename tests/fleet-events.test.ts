import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { EventTriggerSystem } from "../src/fleet/events.ts";
import type { EventTriggerDeps } from "../src/fleet/events.ts";
import type { AgentDefinition } from "../src/fleet/types.ts";
import { insertAgentRun } from "../src/db/index.ts";

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
    schedule: null,
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
let triggered: { id: string; by: string; detail: string }[];

beforeEach(() => {
  db = freshDb();
  triggered = [];
});

function makeDeps(): EventTriggerDeps {
  return {
    db,
    triggerAgent: async (def, by, detail) => {
      triggered.push({ id: def.id, by, detail });
    },
    repoDir: "/tmp/test-repo",
  };
}

describe("EventTriggerSystem", () => {
  describe("on_task_complete", () => {
    test("triggers on exact task ID match", async () => {
      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:6.1" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "6.1");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(1);
      expect(triggered[0].id).toBe("reviewer");
      expect(triggered[0].detail).toContain("on_task_complete:6.1");
    });

    test("does not trigger on non-matching task", () => {
      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:6.1" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "7.1");

      expect(triggered).toHaveLength(0);
    });

    test("triggers on wildcard (*) match", async () => {
      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "anything");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(1);
    });

    test("triggers on glob pattern match (6.*)", async () => {
      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:6.*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "6.3");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(1);
    });

    test("glob pattern does not match unrelated tasks", () => {
      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:6.*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "7.1");

      expect(triggered).toHaveLength(0);
    });
  });

  describe("on_gate_approved", () => {
    test("triggers on matching gate type", async () => {
      const def = makeDef({
        id: "deployer",
        schedule: { type: "event", expression: "on_gate_approved:deploy" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_gate_approved", "deploy");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(1);
      expect(triggered[0].id).toBe("deployer");
    });

    test("does not trigger on non-matching gate type", () => {
      const def = makeDef({
        id: "deployer",
        schedule: { type: "event", expression: "on_gate_approved:deploy" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_gate_approved", "plan_approval");

      expect(triggered).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    test("skips trigger if agent is already running", () => {
      // Insert agent_definitions row first (FK constraint)
      db.prepare(
        "INSERT INTO agent_definitions (id, name, config_path, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
      ).run("reviewer", "Reviewer", "agents/reviewer/agent.md", new Date().toISOString());

      // Insert a running agent_run
      insertAgentRun(db, {
        id: "run-1",
        agent_id: "reviewer",
        session_id: "session-1",
        triggered_by: "schedule",
        trigger_detail: null,
        started_at: new Date().toISOString(),
      });
      db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").run("run-1");

      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "6.1");

      expect(triggered).toHaveLength(0);
    });

    test("triggers if previous run is complete", async () => {
      db.prepare(
        "INSERT INTO agent_definitions (id, name, config_path, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
      ).run("reviewer", "Reviewer", "agents/reviewer/agent.md", new Date().toISOString());

      insertAgentRun(db, {
        id: "run-1",
        agent_id: "reviewer",
        session_id: "session-1",
        triggered_by: "schedule",
        trigger_detail: null,
        started_at: new Date().toISOString(),
      });
      // Mark as complete
      db.prepare("UPDATE agent_runs SET status = 'complete' WHERE id = ?").run(
        "run-1",
      );

      const def = makeDef({
        id: "reviewer",
        schedule: { type: "event", expression: "on_task_complete:*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def]);
      system.emit("on_task_complete", "6.1");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(1);
    });
  });

  describe("updateDefinitions", () => {
    test("rebuilds event registry", async () => {
      const def1 = makeDef({
        id: "agent-1",
        schedule: { type: "event", expression: "on_task_complete:6.1" },
      });
      const def2 = makeDef({
        id: "agent-2",
        schedule: { type: "event", expression: "on_gate_approved:deploy" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def1, def2]);

      system.emit("on_task_complete", "6.1");
      await new Promise((r) => setTimeout(r, 50));
      expect(triggered).toHaveLength(1);
      expect(triggered[0].id).toBe("agent-1");

      // Update to remove def1
      system.updateDefinitions([def2]);
      triggered.length = 0;

      system.emit("on_task_complete", "6.1");
      expect(triggered).toHaveLength(0);

      system.emit("on_gate_approved", "deploy");
      await new Promise((r) => setTimeout(r, 50));
      expect(triggered).toHaveLength(1);
      expect(triggered[0].id).toBe("agent-2");
    });

    test("ignores non-event definitions", () => {
      const cronDef = makeDef({
        schedule: { type: "cron", expression: "0 20 * * *" },
      });
      const manualDef = makeDef({
        id: "manual",
        schedule: { type: "manual" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([cronDef, manualDef]);

      // No event should trigger these
      system.emit("on_task_complete", "anything");
      expect(triggered).toHaveLength(0);
    });
  });

  describe("multiple agents per event", () => {
    test("triggers all matching agents for same event", async () => {
      const def1 = makeDef({
        id: "agent-1",
        schedule: { type: "event", expression: "on_task_complete:*" },
      });
      const def2 = makeDef({
        id: "agent-2",
        schedule: { type: "event", expression: "on_task_complete:*" },
      });

      const system = new EventTriggerSystem(makeDeps());
      system.updateDefinitions([def1, def2]);
      system.emit("on_task_complete", "6.1");

      await new Promise((r) => setTimeout(r, 50));

      expect(triggered).toHaveLength(2);
      expect(triggered.map((t) => t.id).sort()).toEqual([
        "agent-1",
        "agent-2",
      ]);
    });
  });

  describe("stop", () => {
    test("cleans up watchers", () => {
      const system = new EventTriggerSystem(makeDeps());
      system.start();
      system.stop();
      system.stop(); // idempotent
    });
  });
});
