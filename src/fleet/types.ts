import type { Provider } from "../agents/types.ts";

// --- Schedule ---

export type ScheduleType = "cron" | "event" | "manual";

export interface ScheduleConfig {
  type: ScheduleType;
  expression?: string;
}

// --- Output ---

export type OutputDestination =
  | { type: "telegram"; format: "summary" | "full_report" }
  | { type: "github"; format: "summary" | "full_report"; path: string }
  | { type: "webapp" };

// --- Adapter ---

export type AdapterConfig =
  | { type: "llm" }
  | {
      type: "service";
      baseUrl: string;
      auth: string;
      healthCheck: string;
      triggerEndpoint: string;
      statusEndpoint: string;
      outputEndpoint: string;
    };

// --- Tool config ---

export interface ToolConfig {
  name: string;
  options?: Record<string, unknown>;
}

// --- Agent definition ---

export interface AgentDefinition {
  id: string;
  name: string;
  configPath: string;
  agentType: string;
  model: string;
  provider: Provider;
  description: string;
  schedule: ScheduleConfig | null;
  tools: ToolConfig[];
  input: string;
  outputDestinations: OutputDestination[];
  depth: number | null;
  budgetPerRun: number;
  adapterConfig: AdapterConfig;
  enabled: boolean;
}

// --- Agent run ---

export interface AgentRun {
  id: string;
  agentId: string;
  sessionId: string | null;
  triggeredBy: "schedule" | "manual" | "event";
  triggerDetail: string | null;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "complete" | "failed";
  outputRoutedTo: string | null;
}
