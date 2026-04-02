import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadAllAgentDefinitions,
  syncDefinitionsToDb,
  watchAgentDefinitions,
} from "../src/fleet/loader.ts";
import { getAllAgentDefinitions, getAgentDefinition } from "../src/db/index.ts";

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
A test agent

## Input
Do something
`;

const AGENT_MD_2 = `# Second Agent

## Identity
agent_type: custom
model: gemini-3.1-pro
provider: google

## Schedule
on_commit: main

## Description
Another test agent
`;

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-loader-"));
  db = freshDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAllAgentDefinitions", () => {
  test("finds agent.md files in subdirectories", () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);
    mkdirSync(join(tmpDir, "second-agent"));
    writeFileSync(join(tmpDir, "second-agent", "agent.md"), AGENT_MD_2);

    const defs = loadAllAgentDefinitions(tmpDir);

    expect(defs).toHaveLength(2);
    const ids = defs.map((d) => d.id).sort();
    expect(ids).toEqual(["second-agent", "test-agent"]);
  });

  test("skips directories without agent.md", () => {
    mkdirSync(join(tmpDir, "coder"));
    writeFileSync(join(tmpDir, "coder", "system-prompt.md"), "# Coder");
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    const defs = loadAllAgentDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe("test-agent");
  });

  test("skips files (not directories) in agents dir", () => {
    writeFileSync(join(tmpDir, "README.md"), "# Agents");
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    const defs = loadAllAgentDefinitions(tmpDir);
    expect(defs).toHaveLength(1);
  });

  test("logs and skips parse errors", () => {
    mkdirSync(join(tmpDir, "bad-agent"));
    writeFileSync(join(tmpDir, "bad-agent", "agent.md"), "not valid agent md");
    mkdirSync(join(tmpDir, "good-agent"));
    writeFileSync(join(tmpDir, "good-agent", "agent.md"), AGENT_MD);

    const defs = loadAllAgentDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].id).toBe("good-agent");
  });

  test("returns empty array for nonexistent directory", () => {
    const defs = loadAllAgentDefinitions("/nonexistent/path");
    expect(defs).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    const defs = loadAllAgentDefinitions(tmpDir);
    expect(defs).toEqual([]);
  });
});

describe("syncDefinitionsToDb", () => {
  test("inserts new definitions", () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    const defs = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs);

    const rows = getAllAgentDefinitions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("test-agent");
    expect(rows[0].name).toBe("Test Agent");
    expect(rows[0].enabled).toBe(1);
    expect(rows[0].schedule_type).toBe("cron");
    expect(rows[0].schedule_expression).toBe("0 20 * * *");
  });

  test("updates changed definitions", () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    const defs1 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs1);

    // Change the agent definition
    const updatedMd = AGENT_MD.replace("Test Agent", "Updated Agent");
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), updatedMd);

    const defs2 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs2);

    const row = getAgentDefinition(db, "test-agent");
    expect(row).toBeTruthy();
    expect(row!.name).toBe("Updated Agent");
  });

  test("soft-disables removed definitions", () => {
    mkdirSync(join(tmpDir, "agent-a"));
    writeFileSync(join(tmpDir, "agent-a", "agent.md"), AGENT_MD);
    mkdirSync(join(tmpDir, "agent-b"));
    writeFileSync(
      join(tmpDir, "agent-b", "agent.md"),
      AGENT_MD_2,
    );

    // Load both
    const defs1 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs1);

    // Remove agent-b from disk
    rmSync(join(tmpDir, "agent-b"), { recursive: true });
    const defs2 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs2);

    const rows = getAllAgentDefinitions(db);
    expect(rows).toHaveLength(2);

    const agentA = rows.find((r) => r.id === "agent-a");
    const agentB = rows.find((r) => r.id === "agent-b");
    expect(agentA!.enabled).toBe(1);
    expect(agentB!.enabled).toBe(0); // soft-disabled
  });

  test("re-enables previously disabled definition when file returns", () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    // Insert, then disable
    const defs1 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs1);

    rmSync(join(tmpDir, "test-agent"), { recursive: true });
    syncDefinitionsToDb(db, []);

    let row = getAgentDefinition(db, "test-agent");
    expect(row!.enabled).toBe(0);

    // Recreate
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);
    const defs2 = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs2);

    row = getAgentDefinition(db, "test-agent");
    expect(row!.enabled).toBe(1);
  });

  test("does not modify unchanged definitions", () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    const defs = loadAllAgentDefinitions(tmpDir);
    syncDefinitionsToDb(db, defs);

    const row1 = getAgentDefinition(db, "test-agent");

    // Sync again with same definitions
    syncDefinitionsToDb(db, defs);

    const row2 = getAgentDefinition(db, "test-agent");
    expect(row2!.created_at).toBe(row1!.created_at);
  });
});

describe("watchAgentDefinitions", () => {
  test("calls onChange on initial load", async () => {
    mkdirSync(join(tmpDir, "test-agent"));
    writeFileSync(join(tmpDir, "test-agent", "agent.md"), AGENT_MD);

    let receivedDefs: unknown[] = [];
    const watcher = watchAgentDefinitions(tmpDir, (defs) => {
      receivedDefs = defs;
    });

    // Initial load is synchronous via setTimeout(0), but we wait a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedDefs).toHaveLength(1);
    watcher.stop();
  });

  test("stop() cleans up watcher", () => {
    const watcher = watchAgentDefinitions(tmpDir, () => {});
    // Should not throw
    watcher.stop();
    watcher.stop(); // idempotent
  });

  test("detects new agent.md files", async () => {
    let callCount = 0;
    let lastDefs: unknown[] = [];

    const watcher = watchAgentDefinitions(tmpDir, (defs) => {
      callCount++;
      lastDefs = defs;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(callCount).toBe(1); // initial load

    // Add new agent
    mkdirSync(join(tmpDir, "new-agent"));
    writeFileSync(join(tmpDir, "new-agent", "agent.md"), AGENT_MD);

    // Wait for debounce + fs.watch
    await new Promise((r) => setTimeout(r, 1000));

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(lastDefs).toHaveLength(1);

    watcher.stop();
  });
});
