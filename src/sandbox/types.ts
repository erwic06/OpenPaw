import type { Sandbox } from "@daytonaio/sdk";

/** Dependencies injected into sandbox manager for testability. */
export interface SandboxDeps {
  apiKey: string;
  apiUrl?: string;
}

/** Parameters for creating a new sandbox. */
export interface SandboxConfig {
  sessionId: string;
  repoUrl: string;
  branch: string;
}

/**
 * Handle to an active Daytona sandbox, exposing the three operation
 * categories that MCP tools need: filesystem, process, and git.
 */
export interface SandboxHandle {
  sessionId: string;
  sandboxId: string;
  sandbox: Sandbox;
}
