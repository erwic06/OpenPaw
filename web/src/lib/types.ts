export interface Session {
  id: string;
  agent: string;
  task_id: string | null;
  model: string;
  provider: string;
  started_at: string;
  ended_at: string | null;
  terminal_state: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
}

export interface HitlGate {
  id: string;
  gate_type: string;
  task_id: string | null;
  session_id: string | null;
  requested_at: string;
  decided_at: string | null;
  decision: string | null;
  context_summary: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  workspace_path: string | null;
  created_at: string;
}

export interface PendingCommunication {
  id: string;
  gate_id: string | null;
  agent_id: string | null;
  platform: string;
  recipient: string | null;
  content_type: string;
  content: string;
  metadata: string | null;
  created_at: string;
  decided_at: string | null;
  decision: string | null;
  edited_content: string | null;
}

export interface DailySpend {
  date: string;
  total: number;
  breakdown: Array<{ day: string; service: string; total: number }>;
}
