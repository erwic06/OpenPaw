import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recoverOrphanedSessions } from "../src/agents/recovery.ts";
import type { RecoveryDeps } from "../src/agents/recovery.ts";
import { getOrphanedSessions, insertSession } from "../src/db/index.ts";

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

const PLAN_TEMPLATE = `# Test Plan

### 3.9 -- Task A
- **Status:** in-progress
- **Type:** code
- **Contract:** contracts/test.md
- **Dependencies:** none

#### Notes
#### Failure History

---

### 4.0 -- Task B
- **Status:** in-progress
- **Type:** code
- **Contract:** contracts/test2.md
- **Dependencies:** none

#### Notes
#### Failure History

---

### 4.1 -- Task C
- **Status:** ready
- **Type:** code
- **Contract:** contracts/test3.md
- **Dependencies:** none

#### Notes
#### Failure History

---
`;

let db: Database;
let alertMessages: string[];
let testDir: string;

function makeTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recovery-test-"));
  writeFileSync(join(dir, "implementation_plan.md"), PLAN_TEMPLATE);
  return dir;
}

function makeDeps(overrides?: Partial<RecoveryDeps>): RecoveryDeps {
  return {
    db,
    planPath: join(testDir, "implementation_plan.md"),
    sendAlert: mock(async (msg: string) => {
      alertMessages.push(msg);
    }),
    ...overrides,
  };
}

function insertOrphanedSession(
  id: string,
  taskId: string | null,
): void {
  insertSession(db, {
    id,
    agent: "coder",
    task_id: taskId,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    started_at: new Date().toISOString(),
  });
}

function insertCompletedSession(id: string, taskId: string | null): void {
  insertSession(db, {
    id,
    agent: "coder",
    task_id: taskId,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    started_at: new Date().toISOString(),
  });
  db.prepare("UPDATE sessions SET ended_at = ?, terminal_state = ? WHERE id = ?").run(
    new Date().toISOString(),
    "complete",
    id,
  );
}

beforeEach(() => {
  db = freshDb();
  alertMessages = [];
  testDir = makeTestDir();
});

describe("getOrphanedSessions", () => {
  it("returns sessions with ended_at IS NULL", () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "4.0");
    insertCompletedSession("s3", "4.1");

    const orphaned = getOrphanedSessions(db);
    expect(orphaned).toHaveLength(2);
    expect(orphaned.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("returns empty array when no orphans", () => {
    insertCompletedSession("s1", "3.9");
    expect(getOrphanedSessions(db)).toHaveLength(0);
  });

  it("returns empty array on empty table", () => {
    expect(getOrphanedSessions(db)).toHaveLength(0);
  });
});

describe("recoverOrphanedSessions", () => {
  it("returns 0 when no orphaned sessions", async () => {
    const count = await recoverOrphanedSessions(makeDeps());
    expect(count).toBe(0);
    expect(alertMessages).toHaveLength(0);
  });

  it("marks orphaned sessions as FAILED in SQLite", async () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "4.0");

    await recoverOrphanedSessions(makeDeps());

    const sessions = db
      .prepare("SELECT * FROM sessions WHERE terminal_state = 'FAILED'")
      .all() as { id: string; error: string; ended_at: string }[];
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.error).toBe("orchestrator restart, session orphaned");
      expect(s.ended_at).toBeTruthy();
    }
  });

  it("resets corresponding tasks to ready in plan", async () => {
    insertOrphanedSession("s1", "3.9");

    await recoverOrphanedSessions(makeDeps());

    const plan = readFileSync(
      join(testDir, "implementation_plan.md"),
      "utf-8",
    );
    expect(plan).toContain(
      "### 3.9 -- Task A\n- **Status:** ready",
    );
    expect(plan).toContain("prior session interrupted by restart");
  });

  it("resets multiple tasks", async () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "4.0");

    await recoverOrphanedSessions(makeDeps());

    const plan = readFileSync(
      join(testDir, "implementation_plan.md"),
      "utf-8",
    );
    expect(plan).toContain(
      "### 3.9 -- Task A\n- **Status:** ready",
    );
    expect(plan).toContain(
      "### 4.0 -- Task B\n- **Status:** ready",
    );
  });

  it("does not affect unrelated tasks", async () => {
    insertOrphanedSession("s1", "3.9");

    await recoverOrphanedSessions(makeDeps());

    const plan = readFileSync(
      join(testDir, "implementation_plan.md"),
      "utf-8",
    );
    // Task C was already "ready" and should remain so without recovery note
    const taskCSection = plan.split("### 4.1")[1];
    expect(taskCSection).toContain("- **Status:** ready");
    expect(taskCSection).not.toContain("prior session interrupted");
  });

  it("sends alert listing affected tasks", async () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "4.0");

    await recoverOrphanedSessions(makeDeps());

    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("2 orphaned session(s)");
    expect(alertMessages[0]).toContain("3.9");
    expect(alertMessages[0]).toContain("4.0");
  });

  it("handles orphaned session without task_id", async () => {
    insertOrphanedSession("s1", null);

    const count = await recoverOrphanedSessions(makeDeps());

    expect(count).toBe(1);
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toContain("(no tasks)");

    // Session still marked FAILED
    const sessions = db
      .prepare("SELECT * FROM sessions WHERE terminal_state = 'FAILED'")
      .all() as { id: string }[];
    expect(sessions).toHaveLength(1);
  });

  it("returns count of recovered sessions", async () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "4.0");
    insertCompletedSession("s3", "4.1");

    const count = await recoverOrphanedSessions(makeDeps());
    expect(count).toBe(2);
  });

  it("does not double-process on second run", async () => {
    insertOrphanedSession("s1", "3.9");

    await recoverOrphanedSessions(makeDeps());
    // Session now has ended_at set, so second run finds nothing
    const count = await recoverOrphanedSessions(makeDeps());
    expect(count).toBe(0);
  });

  it("does not send alert when no orphans", async () => {
    insertCompletedSession("s1", "3.9");

    await recoverOrphanedSessions(makeDeps());
    expect(alertMessages).toHaveLength(0);
  });

  it("continues recovery if plan update fails", async () => {
    insertOrphanedSession("s1", "3.9");
    insertOrphanedSession("s2", "nonexistent-task");

    const count = await recoverOrphanedSessions(makeDeps());

    // Both sessions marked FAILED even though one task update failed
    expect(count).toBe(2);
    const sessions = db
      .prepare("SELECT * FROM sessions WHERE terminal_state = 'FAILED'")
      .all();
    expect(sessions).toHaveLength(2);
  });
});
