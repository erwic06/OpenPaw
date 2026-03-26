export const GATE_TYPES = [
  "plan",
  "deploy",
  "research",
  "spec_change",
  "spend",
  "external_communication",
] as const;

export type GateType = (typeof GATE_TYPES)[number];

export interface GateRequest {
  gateType: GateType;
  taskId: string | null;
  sessionId: string | null;
  contextSummary: string;
}

export interface GateResult {
  gateId: string;
  decision: "approved" | "denied" | "timeout";
  feedback: string[];
  decidedAt: string;
}

export interface GateConfig {
  timeoutMs: number | null;
  label: string;
}

export const GATE_CONFIGS: Record<GateType, GateConfig> = {
  plan: { timeoutMs: null, label: "Plan Approval" },
  deploy: { timeoutMs: 24 * 60 * 60 * 1000, label: "Deploy Approval" },
  research: { timeoutMs: null, label: "Research Brief Approval" },
  spec_change: { timeoutMs: null, label: "Spec Change" },
  spend: { timeoutMs: null, label: "Spend Threshold" },
  external_communication: { timeoutMs: null, label: "External Communication" },
};
