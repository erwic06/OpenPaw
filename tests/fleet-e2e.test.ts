import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { parseAgentDefinition } from "../src/fleet/parser.ts";
import { loadAllAgentDefinitions, syncDefinitionsToDb } from "../src/fleet/loader.ts";
import { matchesCron } from "../src/fleet/cron.ts";
import { getAllAgentDefinitions } from "../src/db/index.ts";

const SCHEMA_PATH = import.meta.dir + "/../src/db/schema.sql";
const AGENTS_DIR = join(import.meta.dir, "..", "agents");

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

let db: Database;

beforeEach(() => {
  db = freshDb();
});

// --- Parser roundtrip ---

describe("template agents - parser", () => {
  test("TBPN digest parses correctly", () => {
    const content = readFileSync(
      join(AGENTS_DIR, "tbpn-digest", "agent.md"),
      "utf-8",
    );
    const def = parseAgentDefinition(content, "agents/tbpn-digest/agent.md");

    expect(def.id).toBe("tbpn-digest");
    expect(def.name).toBe("TBPN Newsletter Digest");
    expect(def.agentType).toBe("custom");
    expect(def.model).toBe("gemini-3.1-pro");
    expect(def.provider).toBe("google");
    expect(def.schedule).toEqual({ type: "cron", expression: "0 20 * * *" });
    expect(def.tools).toHaveLength(2);
    expect(def.tools[0].name).toBe("browseruse");
    expect(def.tools[0].options).toEqual({ mode: "cloud", headless: true });
    expect(def.tools[1].name).toBe("web_search");
    expect(def.outputDestinations).toHaveLength(2);
    expect(def.outputDestinations[0]).toEqual({ type: "telegram", format: "summary" });
    expect(def.outputDestinations[1]).toEqual({
      type: "github",
      format: "full_report",
      path: "research/tbpn/",
    });
    expect(def.depth).toBe(4);
    expect(def.budgetPerRun).toBe(1.0);
    expect(def.adapterConfig).toEqual({ type: "llm" });
    expect(def.enabled).toBe(true);
  });

  test("daily standup parses correctly", () => {
    const content = readFileSync(
      join(AGENTS_DIR, "daily-standup", "agent.md"),
      "utf-8",
    );
    const def = parseAgentDefinition(
      content,
      "agents/daily-standup/agent.md",
    );

    expect(def.id).toBe("daily-standup");
    expect(def.name).toBe("Daily Standup Summary");
    expect(def.model).toBe("claude-sonnet-4-6");
    expect(def.provider).toBe("anthropic");
    expect(def.schedule).toEqual({ type: "cron", expression: "0 9 * * 1-5" });
    expect(def.tools).toHaveLength(1);
    expect(def.tools[0].name).toBe("file_read");
    expect(def.outputDestinations).toHaveLength(1);
    expect(def.outputDestinations[0]).toEqual({
      type: "telegram",
      format: "summary",
    });
    expect(def.depth).toBeNull();
    expect(def.budgetPerRun).toBe(0.5);
  });

  test("PR reviewer parses correctly", () => {
    const content = readFileSync(
      join(AGENTS_DIR, "pr-reviewer", "agent.md"),
      "utf-8",
    );
    const def = parseAgentDefinition(
      content,
      "agents/pr-reviewer/agent.md",
    );

    expect(def.id).toBe("pr-reviewer");
    expect(def.name).toBe("PR Review on Main");
    expect(def.model).toBe("claude-sonnet-4-6");
    expect(def.provider).toBe("anthropic");
    expect(def.schedule).toEqual({
      type: "event",
      expression: "on_commit:main",
    });
    expect(def.tools).toHaveLength(2);
    expect(def.outputDestinations).toHaveLength(1);
    expect(def.outputDestinations[0]).toEqual({
      type: "github",
      format: "full_report",
      path: "reviews/",
    });
    expect(def.budgetPerRun).toBe(2.0);
  });
});

// --- Loader roundtrip ---

describe("template agents - loader", () => {
  test("loads all template agents from agents directory", () => {
    const defs = loadAllAgentDefinitions(AGENTS_DIR);

    // Should find the 3 template agents (coder/researcher/reviewer dirs lack agent.md)
    const templateIds = defs.map((d) => d.id).sort();
    expect(templateIds).toContain("tbpn-digest");
    expect(templateIds).toContain("daily-standup");
    expect(templateIds).toContain("pr-reviewer");
  });

  test("syncs all template agents to DB", () => {
    const defs = loadAllAgentDefinitions(AGENTS_DIR);
    syncDefinitionsToDb(db, defs);

    const rows = getAllAgentDefinitions(db);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toContain("tbpn-digest");
    expect(ids).toContain("daily-standup");
    expect(ids).toContain("pr-reviewer");

    // All enabled
    for (const row of rows) {
      if (ids.includes(row.id)) {
        expect(row.enabled).toBe(1);
      }
    }
  });

  test("DB rows have correct schedule info", () => {
    const defs = loadAllAgentDefinitions(AGENTS_DIR);
    syncDefinitionsToDb(db, defs);

    const rows = getAllAgentDefinitions(db);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const tbpn = byId.get("tbpn-digest")!;
    expect(tbpn.schedule_type).toBe("cron");
    expect(tbpn.schedule_expression).toBe("0 20 * * *");

    const standup = byId.get("daily-standup")!;
    expect(standup.schedule_type).toBe("cron");
    expect(standup.schedule_expression).toBe("0 9 * * 1-5");

    const reviewer = byId.get("pr-reviewer")!;
    expect(reviewer.schedule_type).toBe("event");
    expect(reviewer.schedule_expression).toBe("on_commit:main");
  });
});

// --- Scheduler verification ---

describe("template agents - scheduling", () => {
  test("TBPN triggers at 8 PM daily", () => {
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T20:00:00"))).toBe(
      true,
    );
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T19:00:00"))).toBe(
      false,
    );
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T20:01:00"))).toBe(
      false,
    );
  });

  test("standup triggers at 9 AM weekdays only", () => {
    // 2026-04-06 is Monday
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-06T09:00:00"))).toBe(
      true,
    );
    // 2026-04-07 is Tuesday
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-07T09:00:00"))).toBe(
      true,
    );
    // 2026-04-11 is Friday
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-10T09:00:00"))).toBe(
      true,
    );
    // 2026-04-05 is Sunday
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-05T09:00:00"))).toBe(
      false,
    );
    // 2026-04-04 is Saturday (day 6, not in 1-5)
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-04T09:00:00"))).toBe(
      false,
    );
  });

  test("standup does not trigger at wrong time on weekday", () => {
    // Monday at 10 AM
    expect(matchesCron("0 9 * * 1-5", new Date("2026-04-06T10:00:00"))).toBe(
      false,
    );
  });
});

// --- Event verification ---

describe("template agents - events", () => {
  test("PR reviewer has on_commit:main event schedule", () => {
    const content = readFileSync(
      join(AGENTS_DIR, "pr-reviewer", "agent.md"),
      "utf-8",
    );
    const def = parseAgentDefinition(content, "agents/pr-reviewer/agent.md");

    expect(def.schedule!.type).toBe("event");
    expect(def.schedule!.expression).toBe("on_commit:main");
  });
});

// --- Output routing validation ---

describe("template agents - output configuration", () => {
  test("all agents have valid output destinations", () => {
    const defs = loadAllAgentDefinitions(AGENTS_DIR);
    const templateDefs = defs.filter((d) =>
      ["tbpn-digest", "daily-standup", "pr-reviewer"].includes(d.id),
    );

    for (const def of templateDefs) {
      for (const dest of def.outputDestinations) {
        expect(["telegram", "github", "webapp"]).toContain(dest.type);
        if (dest.type === "telegram") {
          expect(["summary", "full_report"]).toContain(dest.format);
        }
        if (dest.type === "github") {
          expect(["summary", "full_report"]).toContain(dest.format);
          expect(dest.path).toBeTruthy();
        }
      }
    }
  });
});
