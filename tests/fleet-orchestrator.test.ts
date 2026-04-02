import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FleetOrchestrator } from "../src/fleet/orchestrator.ts";
import type { FleetOrchestratorDeps } from "../src/fleet/orchestrator.ts";
import {
  getAllAgentDefinitions,
  getAgentDefinition,
  getLatestAgentRun,
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

const AGENT_MD = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
cron: "0 20 * * *"

## Description
A test agent for fleet orchestrator testing.

## Input
Do something useful.
`;

const SERVICE_AGENT_MD = `# Service Agent

## Identity
agent_type: custom
model: none
provider: anthropic

## Schedule
cron: "*/5 * * * *"

## Adapter
type: service
base_url: http://localhost:9999
health_check: /health
trigger_endpoint: /trigger
status_endpoint: /status/{session_id}
output_endpoint: /output/{session_id}
`;

let db: Database;
let tmpDir: string;
let agentsDir: string;
let sentMessages: string[];

beforeEach(() => {
  db = freshDb();
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-orch-"));
  agentsDir = join(tmpDir, "agents");
  mkdirSync(agentsDir);
  sentMessages = [];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseDeps(): FleetOrchestratorDeps {
  return {
    db,
    secrets: new Map(),
    sendMessage: async (_chatId, text) => {
      sentMessages.push(text);
    },
    chatId: "12345",
    repoDir: tmpDir,
    agentsDir,
  };
}

describe("FleetOrchestrator", () => {
  test("loads definitions on start", () => {
    mkdirSync(join(agentsDir, "test-agent"));
    writeFileSync(join(agentsDir, "test-agent", "agent.md"), AGENT_MD);

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const rows = getAllAgentDefinitions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("test-agent");
    expect(rows[0].enabled).toBe(1);

    orch.stop();
  });

  test("syncs multiple definitions", () => {
    mkdirSync(join(agentsDir, "agent-a"));
    writeFileSync(join(agentsDir, "agent-a", "agent.md"), AGENT_MD);
    mkdirSync(join(agentsDir, "agent-b"));
    writeFileSync(
      join(agentsDir, "agent-b", "agent.md"),
      AGENT_MD.replace("Test Agent", "Agent B"),
    );

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const rows = getAllAgentDefinitions(db);
    expect(rows).toHaveLength(2);

    orch.stop();
  });

  test("stop() is idempotent", () => {
    const orch = new FleetOrchestrator(baseDeps());
    orch.start();
    orch.stop();
    orch.stop(); // Should not throw
  });

  test("triggerAgent inserts agent_runs row", async () => {
    mkdirSync(join(agentsDir, "test-agent"));
    writeFileSync(join(agentsDir, "test-agent", "agent.md"), AGENT_MD);

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    // triggerAgent for LLM agent will fail (not wired), but should still insert run row
    try {
      const defs = getAllAgentDefinitions(db);
      const def = {
        id: defs[0].id,
        name: defs[0].name,
        configPath: defs[0].config_path,
        agentType: "custom",
        model: "claude-sonnet-4-6",
        provider: "anthropic" as const,
        description: "",
        schedule: { type: "cron" as const, expression: "0 20 * * *" },
        tools: [],
        input: "",
        outputDestinations: [],
        depth: null,
        budgetPerRun: 1.0,
        adapterConfig: { type: "llm" as const },
        enabled: true,
      };
      await orch.triggerAgent(def, "manual", "test");
    } catch {
      // Expected to fail for LLM agents
    }

    // Check that a run was created (even though it failed)
    const run = getLatestAgentRun(db, "test-agent");
    expect(run).toBeTruthy();
    expect(run!.triggered_by).toBe("manual");
    expect(run!.status).toBe("failed");

    orch.stop();
  });

  test("triggerAgent handles errors gracefully", async () => {
    mkdirSync(join(agentsDir, "test-agent"));
    writeFileSync(join(agentsDir, "test-agent", "agent.md"), AGENT_MD);

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const def = {
      id: "test-agent",
      name: "Test Agent",
      configPath: join(agentsDir, "test-agent", "agent.md"),
      agentType: "custom",
      model: "claude-sonnet-4-6",
      provider: "anthropic" as const,
      description: "",
      schedule: { type: "cron" as const, expression: "0 20 * * *" },
      tools: [],
      input: "",
      outputDestinations: [],
      depth: null,
      budgetPerRun: 1.0,
      adapterConfig: { type: "llm" as const },
      enabled: true,
    };

    // Should not throw — errors are caught internally
    await orch.triggerAgent(def, "schedule", "0 20 * * *");

    const run = getLatestAgentRun(db, "test-agent");
    expect(run).toBeTruthy();
    expect(run!.status).toBe("failed");

    orch.stop();
  });

  test("scheduler computes next_run_at for cron definitions", () => {
    mkdirSync(join(agentsDir, "test-agent"));
    writeFileSync(join(agentsDir, "test-agent", "agent.md"), AGENT_MD);

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const row = getAgentDefinition(db, "test-agent");
    expect(row).toBeTruthy();
    expect(row!.next_run_at).toBeTruthy();

    orch.stop();
  });

  test("event system is accessible via getEventSystem", () => {
    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const eventSystem = orch.getEventSystem();
    expect(eventSystem).toBeTruthy();

    orch.stop();
  });

  test("scheduler is accessible via getScheduler", () => {
    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const scheduler = orch.getScheduler();
    expect(scheduler).toBeTruthy();

    orch.stop();
  });

  test("skips directories without agent.md", () => {
    mkdirSync(join(agentsDir, "coder"));
    writeFileSync(join(agentsDir, "coder", "system_prompt.md"), "# Coder");
    mkdirSync(join(agentsDir, "test-agent"));
    writeFileSync(join(agentsDir, "test-agent", "agent.md"), AGENT_MD);

    const orch = new FleetOrchestrator(baseDeps());
    orch.start();

    const rows = getAllAgentDefinitions(db);
    expect(rows).toHaveLength(1);

    orch.stop();
  });
});
