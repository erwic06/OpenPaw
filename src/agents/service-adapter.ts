import type { Database } from "bun:sqlite";
import type { AgentAdapter, AgentInput, AgentOutput, AgentStatus } from "./types.ts";
import { insertSession, updateSession } from "../db/index.ts";

export interface ServiceAdapterConfig {
  baseUrl: string;
  auth: string;
  healthCheck: string;
  triggerEndpoint: string;
  statusEndpoint: string;
  outputEndpoint: string;
}

export interface ServiceAdapterDeps {
  db: Database;
  config: ServiceAdapterConfig;
  fetchFn?: typeof fetch;
  secrets?: Map<string, string>;
}

export class ServiceAdapterError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ServiceAdapterError";
    this.retryable = retryable;
  }
}

const TRIGGER_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ServiceAdapter implements AgentAdapter {
  private deps: ServiceAdapterDeps;

  constructor(deps: ServiceAdapterDeps) {
    this.deps = deps;
  }

  async trigger(input: AgentInput): Promise<string> {
    const sessionId = `service-${crypto.randomUUID()}`;
    const url = `${this.deps.config.baseUrl}${this.deps.config.triggerEndpoint}`;

    const res = await this.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        tools: input.tools,
        budgetUsd: input.budgetUsd,
      }),
    }, TRIGGER_TIMEOUT_MS);

    if (!res.ok) {
      const retryable = res.status >= 500;
      throw new ServiceAdapterError(
        `Service trigger failed: ${res.status} ${res.statusText}`,
        retryable,
      );
    }

    insertSession(this.deps.db, {
      id: sessionId,
      agent: "service",
      task_id: input.taskId,
      model: "external",
      provider: "anthropic", // placeholder — service agents don't use LLM providers
      started_at: new Date().toISOString(),
    });

    return sessionId;
  }

  async status(sessionId: string): Promise<AgentStatus> {
    const url = this.resolveEndpoint(this.deps.config.statusEndpoint, sessionId);
    const res = await this.fetch(url, { method: "GET" }, DEFAULT_TIMEOUT_MS);

    if (!res.ok) {
      const retryable = res.status >= 500;
      throw new ServiceAdapterError(
        `Service status check failed: ${res.status}`,
        retryable,
      );
    }

    const data = await res.json() as { status: string };
    return mapStatus(data.status);
  }

  async output(sessionId: string): Promise<AgentOutput> {
    const url = this.resolveEndpoint(this.deps.config.outputEndpoint, sessionId);
    const res = await this.fetch(url, { method: "GET" }, DEFAULT_TIMEOUT_MS);

    if (!res.ok) {
      const retryable = res.status >= 500;
      throw new ServiceAdapterError(
        `Service output retrieval failed: ${res.status}`,
        retryable,
      );
    }

    const data = await res.json() as {
      artifacts?: string[];
      costUsd?: number;
      error?: string | null;
    };

    return {
      sessionId,
      terminalState: data.error ? "failed" : "complete",
      artifacts: data.artifacts ?? [],
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: data.costUsd ?? 0,
      error: data.error ?? null,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const url = this.resolveEndpoint(this.deps.config.statusEndpoint, sessionId);
    const res = await this.fetch(url, { method: "DELETE" }, DEFAULT_TIMEOUT_MS);

    if (!res.ok && res.status !== 404) {
      const retryable = res.status >= 500;
      throw new ServiceAdapterError(
        `Service cancel failed: ${res.status}`,
        retryable,
      );
    }

    updateSession(this.deps.db, sessionId, {
      ended_at: new Date().toISOString(),
      terminal_state: "failed",
      error: "Cancelled by user",
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.deps.config.baseUrl}${this.deps.config.healthCheck}`;
      const res = await this.fetch(url, { method: "GET" }, DEFAULT_TIMEOUT_MS);
      return res.ok;
    } catch {
      return false;
    }
  }

  private resolveAuth(): string {
    const auth = this.deps.config.auth;
    if (!auth) return "";

    // Resolve ${SECRET_NAME} references from secrets map
    const secretMatch = auth.match(/\$\{(.+?)\}/);
    if (secretMatch && this.deps.secrets) {
      const secretName = secretMatch[1];
      const secretValue = this.deps.secrets.get(secretName);
      if (!secretValue) {
        throw new Error(`Secret "${secretName}" not found`);
      }
      return auth.replace(secretMatch[0], secretValue);
    }

    return auth;
  }

  private resolveEndpoint(template: string, sessionId: string): string {
    const path = template.includes("{session_id}")
      ? template.replace("{session_id}", sessionId)
      : `${template}/${sessionId}`;
    return `${this.deps.config.baseUrl}${path}`;
  }

  private async fetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const auth = this.resolveAuth();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    };
    if (auth) {
      // If auth contains "bearer", use as-is; otherwise wrap as Bearer
      headers["Authorization"] = auth.toLowerCase().startsWith("bearer ")
        ? auth
        : `Bearer ${auth}`;
    }

    try {
      return await fetchFn(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Timeouts and connection errors are retryable
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceAdapterError(
        `Service request failed: ${message}`,
        true,
      );
    }
  }
}

function mapStatus(raw: string): AgentStatus {
  switch (raw) {
    case "running":
    case "pending":
    case "in_progress":
      return "running";
    case "complete":
    case "completed":
    case "success":
      return "complete";
    case "failed":
    case "error":
      return "failed";
    case "waiting_hitl":
    case "waiting":
      return "waiting_hitl";
    default:
      return "running";
  }
}
