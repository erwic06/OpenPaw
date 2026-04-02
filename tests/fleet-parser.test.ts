import { describe, test, expect } from "bun:test";
import { parseAgentDefinition } from "../src/fleet/parser.ts";

const TBPN_AGENT = `# TBPN Newsletter Digest

## Identity
agent_type: custom
model: gemini-3.1-pro
provider: google

## Description
Reads the daily TBPN newsletter and produces a concise digest highlighting the most relevant items
for an AI/ML engineer focused on agentic systems and developer tools.

## Schedule
cron: "0 20 * * *"

## Tools
- browseruse:
    mode: cloud
    headless: true
- file_write: true

## Input
Navigate to [TBPN newsletter URL] and read today's edition. If no new edition today, report "No new
edition" and terminate.

## Output
- telegram: summary
- github: full_report (path: research/tbpn/)

## Depth
level: 4

## Budget
max_cost_per_run: $1.00
`;

describe("parseAgentDefinition", () => {
  test("parses TBPN example from design doc", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");

    expect(def.id).toBe("tbpn-digest");
    expect(def.name).toBe("TBPN Newsletter Digest");
    expect(def.configPath).toBe("agents/tbpn-digest/agent.md");
    expect(def.agentType).toBe("custom");
    expect(def.model).toBe("gemini-3.1-pro");
    expect(def.provider).toBe("google");
    expect(def.description).toContain("TBPN newsletter");
    expect(def.enabled).toBe(true);
  });

  test("parses cron schedule", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");

    expect(def.schedule).toEqual({
      type: "cron",
      expression: "0 20 * * *",
    });
  });

  test("parses event schedule - on_commit", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
on_commit: main
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.schedule).toEqual({
      type: "event",
      expression: "on_commit:main",
    });
  });

  test("parses event schedule - on_task_complete", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
on_task_complete: *
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.schedule).toEqual({
      type: "event",
      expression: "on_task_complete:*",
    });
  });

  test("parses event schedule - on_gate_approved", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
on_gate_approved: deploy
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.schedule).toEqual({
      type: "event",
      expression: "on_gate_approved:deploy",
    });
  });

  test("parses tools with nested config", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");

    expect(def.tools).toEqual([
      { name: "browseruse", options: { mode: "cloud", headless: true } },
      { name: "file_write" },
    ]);
  });

  test("parses output destinations", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");

    expect(def.outputDestinations).toEqual([
      { type: "telegram", format: "summary" },
      { type: "github", format: "full_report", path: "research/tbpn/" },
    ]);
  });

  test("parses depth", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");
    expect(def.depth).toBe(4);
  });

  test("parses budget", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");
    expect(def.budgetPerRun).toBe(1.0);
  });

  test("parses input section", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");
    expect(def.input).toContain("Navigate to [TBPN newsletter URL]");
    expect(def.input).toContain("No new\nedition");
  });

  test("defaults adapter to llm when section missing", () => {
    const def = parseAgentDefinition(TBPN_AGENT, "agents/tbpn-digest/agent.md");
    expect(def.adapterConfig).toEqual({ type: "llm" });
  });

  test("parses service adapter", () => {
    const md = `# Calendar Agent

## Identity
agent_type: custom
model: none
provider: anthropic

## Adapter
type: service
base_url: http://localhost:8100
auth: bearer token123
health_check: /health
trigger_endpoint: /trigger
status_endpoint: /status
output_endpoint: /output
`;
    const def = parseAgentDefinition(md, "agents/calendar/agent.md");
    expect(def.adapterConfig).toEqual({
      type: "service",
      baseUrl: "http://localhost:8100",
      auth: "bearer token123",
      healthCheck: "/health",
      triggerEndpoint: "/trigger",
      statusEndpoint: "/status",
      outputEndpoint: "/output",
    });
  });

  test("handles missing optional sections gracefully", () => {
    const md = `# Minimal Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic
`;
    const def = parseAgentDefinition(md, "agents/minimal/agent.md");
    expect(def.schedule).toBeNull();
    expect(def.tools).toEqual([]);
    expect(def.outputDestinations).toEqual([]);
    expect(def.depth).toBeNull();
    expect(def.budgetPerRun).toBe(0);
    expect(def.description).toBe("");
    expect(def.input).toBe("");
    expect(def.adapterConfig).toEqual({ type: "llm" });
  });

  test("extracts agent ID from path", () => {
    const md = `# Test

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic
`;
    expect(parseAgentDefinition(md, "agents/my-agent/agent.md").id).toBe("my-agent");
    expect(parseAgentDefinition(md, "/full/path/agents/deep-agent/agent.md").id).toBe("deep-agent");
  });

  test("throws on missing H1 title", () => {
    const md = `## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "H1 title",
    );
  });

  test("throws on missing Identity section", () => {
    const md = `# Test Agent

## Description
Some description
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "Identity",
    );
  });

  test("throws on invalid provider", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: some-model
provider: invalid_provider
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      'Invalid provider "invalid_provider"',
    );
  });

  test("throws on invalid cron expression", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
cron: "* * *"
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "5 fields",
    );
  });

  test("throws on invalid depth", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Depth
level: 15
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "1-10",
    );
  });

  test("throws on depth of 0", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Depth
level: 0
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "1-10",
    );
  });

  test("throws on invalid budget format", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Budget
max_cost_per_run: expensive
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "Invalid budget format",
    );
  });

  test("throws on invalid configPath", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic
`;
    expect(() => parseAgentDefinition(md, "some/random/path.md")).toThrow(
      "Cannot extract agent ID",
    );
  });

  test("throws on missing Identity fields", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
`;
    expect(() => parseAgentDefinition(md, "agents/test/agent.md")).toThrow(
      "model",
    );
  });

  test("parses webapp output destination", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Output
- webapp: true
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.outputDestinations).toEqual([{ type: "webapp" }]);
  });

  test("skips notion output silently", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Output
- telegram: summary
- notion: full_report
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.outputDestinations).toHaveLength(1);
    expect(def.outputDestinations[0].type).toBe("telegram");
  });

  test("parses github output without path", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Output
- github: summary
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.outputDestinations).toEqual([
      { type: "github", format: "summary", path: "" },
    ]);
  });

  test("parses budget without dollar sign", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Budget
max_cost_per_run: 2.50
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.budgetPerRun).toBe(2.5);
  });

  test("service adapter defaults optional endpoints", () => {
    const md = `# Service Agent

## Identity
agent_type: custom
model: none
provider: anthropic

## Adapter
type: service
base_url: http://localhost:9000
`;
    const def = parseAgentDefinition(md, "agents/svc/agent.md");
    expect(def.adapterConfig).toEqual({
      type: "service",
      baseUrl: "http://localhost:9000",
      auth: "",
      healthCheck: "/health",
      triggerEndpoint: "/trigger",
      statusEndpoint: "/status",
      outputEndpoint: "/output",
    });
  });

  test("throws on service adapter without base_url", () => {
    const md = `# Service Agent

## Identity
agent_type: custom
model: none
provider: anthropic

## Adapter
type: service
`;
    expect(() => parseAgentDefinition(md, "agents/svc/agent.md")).toThrow(
      "base_url",
    );
  });

  test("manual schedule when section has no recognized keys", () => {
    const md = `# Test Agent

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Schedule
manual trigger only
`;
    const def = parseAgentDefinition(md, "agents/test/agent.md");
    expect(def.schedule).toEqual({ type: "manual" });
  });
});
