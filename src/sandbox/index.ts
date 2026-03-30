import { Daytona, CodeLanguage } from "@daytonaio/sdk";
import type { SandboxConfig, SandboxDeps, SandboxHandle } from "./types.ts";

export type { SandboxConfig, SandboxDeps, SandboxHandle } from "./types.ts";

const WORKSPACE_DIR = "/home/daytona";
const SANDBOX_TIMEOUT_S = 120;

/** Active sandboxes keyed by session ID. */
const activeSandboxes = new Map<string, SandboxHandle>();

/** Lazily cached Daytona client. */
let cachedClient: Daytona | null = null;
let cachedDeps: SandboxDeps | null = null;

function getClient(deps: SandboxDeps): Daytona {
  // Re-create if deps changed (different apiKey/apiUrl).
  if (
    cachedClient &&
    cachedDeps &&
    cachedDeps.apiKey === deps.apiKey &&
    cachedDeps.apiUrl === deps.apiUrl
  ) {
    return cachedClient;
  }
  cachedClient = new Daytona({
    apiKey: deps.apiKey,
    apiUrl: deps.apiUrl,
  });
  cachedDeps = deps;
  return cachedClient;
}

/**
 * Create a Daytona sandbox for a headless session.
 * Clones the project repo and returns a handle for tool operations.
 */
export async function createSandbox(
  deps: SandboxDeps,
  config: SandboxConfig,
): Promise<SandboxHandle> {
  if (activeSandboxes.has(config.sessionId)) {
    throw new Error(
      `Sandbox already exists for session: ${config.sessionId}`,
    );
  }

  const client = getClient(deps);
  const sandbox = await client.create(
    {
      language: CodeLanguage.TYPESCRIPT,
      labels: { sessionId: config.sessionId },
      autoStopInterval: 0, // disable auto-stop; we manage lifecycle
    },
    { timeout: SANDBOX_TIMEOUT_S },
  );

  await sandbox.git.clone(config.repoUrl, WORKSPACE_DIR, config.branch);

  const handle: SandboxHandle = {
    sessionId: config.sessionId,
    sandboxId: sandbox.id,
    sandbox,
  };

  activeSandboxes.set(config.sessionId, handle);
  return handle;
}

/**
 * Retrieve an active sandbox handle by session ID.
 * Returns undefined if no sandbox exists for the session.
 */
export function getSandbox(sessionId: string): SandboxHandle | undefined {
  return activeSandboxes.get(sessionId);
}

/**
 * Destroy a sandbox and remove it from the active map.
 * No-op if the session has no active sandbox.
 */
export async function destroySandbox(
  deps: SandboxDeps,
  sessionId: string,
): Promise<void> {
  const handle = activeSandboxes.get(sessionId);
  if (!handle) {
    return;
  }

  const client = getClient(deps);
  await client.delete(handle.sandbox);
  activeSandboxes.delete(sessionId);
}

/**
 * Reset internal state. Exposed for testing only.
 * @internal
 */
export function _resetForTesting(): void {
  activeSandboxes.clear();
  cachedClient = null;
  cachedDeps = null;
}
