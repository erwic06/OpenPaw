import { describe, expect, test } from "bun:test";
import type {
  ScheduleType,
  ScheduleConfig,
  OutputDestination,
  AdapterConfig,
  ToolConfig,
  AgentDefinition,
  AgentRun,
} from "../src/fleet/types.ts";

describe("fleet types", () => {
  test("ScheduleConfig with cron expression", () => {
    const config: ScheduleConfig = { type: "cron", expression: "0 20 * * *" };
    expect(config.type).toBe("cron");
    expect(config.expression).toBe("0 20 * * *");
  });

  test("ScheduleConfig with event expression", () => {
    const config: ScheduleConfig = { type: "event", expression: "on_commit: main" };
    expect(config.type).toBe("event");
    expect(config.expression).toBe("on_commit: main");
  });

  test("ScheduleConfig for manual (no expression)", () => {
    const config: ScheduleConfig = { type: "manual" };
    expect(config.type).toBe("manual");
    expect(config.expression).toBeUndefined();
  });

  test("OutputDestination telegram variant", () => {
    const dest: OutputDestination = { type: "telegram", format: "summary" };
    expect(dest.type).toBe("telegram");
    if (dest.type === "telegram") {
      expect(dest.format).toBe("summary");
    }
  });

  test("OutputDestination github variant with path", () => {
    const dest: OutputDestination = { type: "github", format: "full_report", path: "research/tbpn/" };
    expect(dest.type).toBe("github");
    if (dest.type === "github") {
      expect(dest.format).toBe("full_report");
      expect(dest.path).toBe("research/tbpn/");
    }
  });

  test("OutputDestination webapp variant", () => {
    const dest: OutputDestination = { type: "webapp" };
    expect(dest.type).toBe("webapp");
  });

  test("AdapterConfig llm (default)", () => {
    const config: AdapterConfig = { type: "llm" };
    expect(config.type).toBe("llm");
  });

  test("AdapterConfig service with full config", () => {
    const config: AdapterConfig = {
      type: "service",
      baseUrl: "http://localhost:8100",
      auth: "bearer ${CALENDAR_AGENT_TOKEN}",
      healthCheck: "/health",
      triggerEndpoint: "POST /tasks",
      statusEndpoint: "GET /tasks/{session_id}",
      outputEndpoint: "GET /tasks/{session_id}/output",
    };
    expect(config.type).toBe("service");
    if (config.type === "service") {
      expect(config.baseUrl).toBe("http://localhost:8100");
      expect(config.triggerEndpoint).toBe("POST /tasks");
    }
  });

  test("ToolConfig with options", () => {
    const tool: ToolConfig = { name: "browseruse", options: { mode: "cloud", headless: true } };
    expect(tool.name).toBe("browseruse");
    expect(tool.options?.mode).toBe("cloud");
  });

  test("ToolConfig without options", () => {
    const tool: ToolConfig = { name: "web_search" };
    expect(tool.name).toBe("web_search");
    expect(tool.options).toBeUndefined();
  });

  test("AgentDefinition full structure", () => {
    const def: AgentDefinition = {
      id: "tbpn-digest",
      name: "TBPN Newsletter Digest",
      configPath: "agents/tbpn-digest/agent.md",
      agentType: "custom",
      model: "gemini-3.1-pro",
      provider: "google",
      description: "Reads the daily TBPN newsletter",
      schedule: { type: "cron", expression: "0 20 * * *" },
      tools: [{ name: "browseruse", options: { mode: "cloud" } }],
      input: "Navigate to TBPN newsletter and read today's edition.",
      outputDestinations: [
        { type: "telegram", format: "summary" },
        { type: "github", format: "full_report", path: "research/tbpn/" },
      ],
      depth: 4,
      budgetPerRun: 1.0,
      adapterConfig: { type: "llm" },
      enabled: true,
    };

    expect(def.id).toBe("tbpn-digest");
    expect(def.schedule?.type).toBe("cron");
    expect(def.outputDestinations).toHaveLength(2);
    expect(def.adapterConfig.type).toBe("llm");
  });

  test("AgentDefinition with service adapter", () => {
    const def: AgentDefinition = {
      id: "calendar-agent",
      name: "Calendar Agent",
      configPath: "agents/calendar-agent/agent.md",
      agentType: "custom",
      model: "external",
      provider: "anthropic", // placeholder for service agents
      description: "Fetches daily calendar",
      schedule: { type: "cron", expression: "0 8 * * *" },
      tools: [],
      input: "Get today's calendar events",
      outputDestinations: [{ type: "telegram", format: "summary" }],
      depth: null,
      budgetPerRun: 0,
      adapterConfig: {
        type: "service",
        baseUrl: "http://localhost:8100",
        auth: "bearer token",
        healthCheck: "/health",
        triggerEndpoint: "POST /tasks",
        statusEndpoint: "GET /tasks/{session_id}",
        outputEndpoint: "GET /tasks/{session_id}/output",
      },
      enabled: true,
    };

    expect(def.adapterConfig.type).toBe("service");
    if (def.adapterConfig.type === "service") {
      expect(def.adapterConfig.baseUrl).toBe("http://localhost:8100");
    }
  });

  test("AgentRun structure", () => {
    const run: AgentRun = {
      id: "run-tbpn-1712000000000",
      agentId: "tbpn-digest",
      sessionId: "session-123",
      triggeredBy: "schedule",
      triggerDetail: "0 20 * * *",
      startedAt: "2026-04-02T20:00:00.000Z",
      endedAt: "2026-04-02T20:05:00.000Z",
      status: "complete",
      outputRoutedTo: '["telegram","github"]',
    };

    expect(run.agentId).toBe("tbpn-digest");
    expect(run.triggeredBy).toBe("schedule");
    expect(run.status).toBe("complete");
  });

  test("AgentRun with manual trigger", () => {
    const run: AgentRun = {
      id: "run-manual-1712000000000",
      agentId: "tbpn-digest",
      sessionId: null,
      triggeredBy: "manual",
      triggerDetail: null,
      startedAt: "2026-04-02T15:00:00.000Z",
      endedAt: null,
      status: "running",
      outputRoutedTo: null,
    };

    expect(run.triggeredBy).toBe("manual");
    expect(run.sessionId).toBeNull();
    expect(run.status).toBe("running");
  });
});
