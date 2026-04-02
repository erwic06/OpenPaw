import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { routeOutput } from "../src/fleet/router.ts";
import type { RoutingDeps, SpawnSyncFn } from "../src/fleet/router.ts";
import type { AgentDefinition } from "../src/fleet/types.ts";
import type { AgentOutput } from "../src/agents/types.ts";

function makeAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "test-agent",
    name: "Test Agent",
    configPath: "agents/test-agent/agent.md",
    agentType: "custom",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    description: "A test agent",
    schedule: null,
    tools: [],
    input: "Do something",
    outputDestinations: [],
    depth: null,
    budgetPerRun: 1.0,
    adapterConfig: { type: "llm" },
    enabled: true,
    ...overrides,
  };
}

function makeOutput(overrides?: Partial<AgentOutput>): AgentOutput {
  return {
    sessionId: "session-123",
    terminalState: "complete",
    artifacts: ["result.txt"],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.38,
    error: null,
    ...overrides,
  };
}

function mockSpawnSync(): { fn: SpawnSyncFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnSyncFn = (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { fn, calls };
}

describe("routeOutput", () => {
  let sentMessages: { chatId: string; text: string }[];
  let deps: RoutingDeps;
  let tmpDir: string;
  let spawn: ReturnType<typeof mockSpawnSync>;

  beforeEach(() => {
    sentMessages = [];
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-router-"));
    spawn = mockSpawnSync();
    deps = {
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
      },
      chatId: "12345",
      repoDir: tmpDir,
      spawnSyncFn: spawn.fn,
    };
  });

  describe("telegram routing", () => {
    test("summary format sends condensed message", async () => {
      const agentDef = makeAgentDef({
        name: "TBPN Digest",
        outputDestinations: [{ type: "telegram", format: "summary" }],
      });
      const output = makeOutput();

      const results = await routeOutput(deps, agentDef, output);

      expect(results).toHaveLength(1);
      expect(results[0].destination).toBe("telegram");
      expect(results[0].success).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe("12345");
      expect(sentMessages[0].text).toContain("<b>TBPN Digest</b>");
      expect(sentMessages[0].text).toContain("Complete");
      expect(sentMessages[0].text).toContain("$0.38");
    });

    test("summary format shows error on failure", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [{ type: "telegram", format: "summary" }],
      });
      const output = makeOutput({
        terminalState: "failed",
        error: "timeout exceeded",
      });

      await routeOutput(deps, agentDef, output);

      expect(sentMessages[0].text).toContain("Failed");
      expect(sentMessages[0].text).toContain("timeout exceeded");
    });

    test("full_report format sends truncated preview", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [{ type: "telegram", format: "full_report" }],
      });
      const output = makeOutput();

      await routeOutput(deps, agentDef, output);

      expect(sentMessages[0].text).toContain("Full report available on GitHub");
    });
  });

  describe("github routing", () => {
    test("commits output file at specified path", async () => {
      const agentDef = makeAgentDef({
        name: "TBPN Digest",
        outputDestinations: [
          { type: "github", format: "full_report", path: "research/tbpn" },
        ],
      });
      const output = makeOutput();

      const results = await routeOutput(deps, agentDef, output);

      expect(results).toHaveLength(1);
      expect(results[0].destination).toBe("github:research/tbpn");
      expect(results[0].success).toBe(true);

      // Check file was written
      const date = new Date().toISOString().slice(0, 10);
      const filePath = join(tmpDir, "research/tbpn", `${date}.md`);
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("# TBPN Digest");
      expect(content).toContain("**Status:** Complete");
      expect(content).toContain("$0.38");
    });

    test("git commands include agent name in commit message", async () => {
      const agentDef = makeAgentDef({
        name: "TBPN Digest",
        outputDestinations: [
          { type: "github", format: "full_report", path: "research/tbpn" },
        ],
      });

      await routeOutput(deps, agentDef, makeOutput());

      // Check git commit was called with proper message
      const commitCall = spawn.calls.find(
        (args) => args.includes("commit"),
      );
      expect(commitCall).toBeTruthy();
      const commitMsg = commitCall![commitCall!.indexOf("-m") + 1];
      expect(commitMsg).toContain("[agent] TBPN Digest");
    });

    test("git add, commit, push sequence", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [
          { type: "github", format: "full_report", path: "output" },
        ],
      });

      await routeOutput(deps, agentDef, makeOutput());

      const commands = spawn.calls.map((args) => {
        const gitIdx = args.indexOf("git");
        const cmdIdx = args.findIndex(
          (a, i) => i > gitIdx + 2 && !a.startsWith("-"),
        );
        return args[cmdIdx];
      });
      expect(commands).toEqual(["add", "commit", "push"]);
    });

    test("git failure returns error result", async () => {
      const failSpawn: SpawnSyncFn = (args) => {
        if (args.includes("push")) {
          return { exitCode: 1, stdout: "", stderr: "push rejected" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const agentDef = makeAgentDef({
        outputDestinations: [
          { type: "github", format: "full_report", path: "out" },
        ],
      });

      const results = await routeOutput(
        { ...deps, spawnSyncFn: failSpawn },
        agentDef,
        makeOutput(),
      );

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("push");
    });

    test("output content includes error when failed", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [
          { type: "github", format: "full_report", path: "out" },
        ],
      });
      const output = makeOutput({
        terminalState: "failed",
        error: "something broke",
      });

      await routeOutput(deps, agentDef, output);

      const date = new Date().toISOString().slice(0, 10);
      const content = readFileSync(
        join(tmpDir, "out", `${date}.md`),
        "utf-8",
      );
      expect(content).toContain("## Error");
      expect(content).toContain("something broke");
    });
  });

  describe("webapp routing", () => {
    test("no-op for webapp destination", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [{ type: "webapp" }],
      });

      const results = await routeOutput(deps, agentDef, makeOutput());

      expect(results).toHaveLength(1);
      expect(results[0].destination).toBe("webapp");
      expect(results[0].success).toBe(true);
      expect(sentMessages).toHaveLength(0);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  describe("error isolation", () => {
    test("one destination failure does not block others", async () => {
      const failSend = async () => {
        throw new Error("telegram down");
      };

      const agentDef = makeAgentDef({
        outputDestinations: [
          { type: "telegram", format: "summary" },
          { type: "webapp" },
        ],
      });

      const results = await routeOutput(
        { ...deps, sendMessage: failSend },
        agentDef,
        makeOutput(),
      );

      expect(results).toHaveLength(2);
      expect(results[0].destination).toBe("telegram");
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("telegram down");
      expect(results[1].destination).toBe("webapp");
      expect(results[1].success).toBe(true);
    });
  });

  describe("multiple destinations", () => {
    test("routes to all configured destinations", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [
          { type: "telegram", format: "summary" },
          { type: "github", format: "full_report", path: "reports" },
          { type: "webapp" },
        ],
      });

      const results = await routeOutput(deps, agentDef, makeOutput());

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe("serialization", () => {
    test("results serialize to JSON for DB storage", async () => {
      const agentDef = makeAgentDef({
        outputDestinations: [{ type: "telegram", format: "summary" }],
      });

      const results = await routeOutput(deps, agentDef, makeOutput());
      const json = JSON.stringify(results);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(results);
    });
  });

  describe("no destinations", () => {
    test("returns empty array when no destinations configured", async () => {
      const agentDef = makeAgentDef({ outputDestinations: [] });
      const results = await routeOutput(deps, agentDef, makeOutput());
      expect(results).toEqual([]);
    });
  });
});
