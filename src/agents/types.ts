// --- Agent status ---

export type AgentStatus = "running" | "complete" | "failed" | "waiting_hitl";

// --- Model configuration ---

export type ModelTier = "heavy" | "standard" | "light";

export type Provider = "anthropic" | "openai";

export interface ModelConfig {
  primary: { model: string; provider: Provider };
  fallback: { model: string; provider: Provider };
}

export type ModelRoster = Record<ModelTier, ModelConfig>;

export const DEFAULT_ROSTER: ModelRoster = {
  heavy: {
    primary: { model: "claude-opus-4-6", provider: "anthropic" },
    fallback: { model: "gpt-5.4", provider: "openai" },
  },
  standard: {
    primary: { model: "claude-sonnet-4-6", provider: "anthropic" },
    fallback: { model: "gpt-5.4", provider: "openai" },
  },
  light: {
    primary: { model: "gpt-5.4-mini", provider: "openai" },
    fallback: { model: "claude-haiku-4-5", provider: "anthropic" },
  },
};

// --- Agent input/output ---

export interface AgentInput {
  taskId: string;
  taskTitle: string;
  contractPath: string;
  systemPromptPath: string | null;
  modelTier: ModelTier;
  tools: string[];
  budgetUsd: number;
}

export interface AgentOutput {
  sessionId: string;
  terminalState: AgentStatus & ("complete" | "failed");
  artifacts: string[];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  error: string | null;
}

// --- Adapter interface ---

export interface AgentAdapter {
  trigger(input: AgentInput): Promise<string>;
  status(sessionId: string): Promise<AgentStatus>;
  output(sessionId: string): Promise<AgentOutput>;
  cancel(sessionId: string): Promise<void>;
}
