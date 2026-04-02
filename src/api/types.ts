import type { Database } from "bun:sqlite";

export interface Route {
  method: string;
  pattern: string;
  handler: (ctx: ApiContext) => Response | Promise<Response>;
}

export interface ApiContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  deps: ApiDeps;
}

export interface ApiDeps {
  db: Database;
  resolveGateFn?: (
    gateId: string,
    decision: "approved" | "denied",
    feedback?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  planPath?: string;
  events?: NanoClawEventsInterface;
  createResearchTask?: (opts: {
    prompt: string;
    depth: number;
  }) => Promise<string>;
  createCodingTask?: (opts: {
    projectName: string;
    prompt: string;
  }) => Promise<string>;
  createProject?: (opts: {
    name: string;
    description: string;
  }) => Promise<string>;
}

export interface AuthDeps {
  teamDomain: string;
  audienceTag: string;
  allowedEmail?: string;
  fetchFn?: typeof fetch;
}

export interface NanoClawEventsInterface {
  emit(channel: string, event: WsMessage): void;
  subscribe(channel: string, ws: unknown): void;
  unsubscribe(channel: string, ws: unknown): void;
}

export type WsMessageType =
  | "status_change"
  | "cost_update"
  | "text"
  | "gate_pending"
  | "gate_resolved"
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "budget_warning"
  | "alert"
  | "ping";

export interface WsMessage {
  type: WsMessageType;
  data?: unknown;
  timestamp: string;
}
