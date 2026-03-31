import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxConfig, SandboxDeps, SandboxHandle } from "./types.ts";

export type { SandboxConfig, SandboxDeps, SandboxHandle } from "./types.ts";

/** Active sandboxes keyed by session ID. */
const activeSandboxes = new Map<string, SandboxHandle>();

function runGit(
  deps: SandboxDeps,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  if (deps.spawnSyncFn) {
    return deps.spawnSyncFn(args);
  }
  const result = Bun.spawnSync(["git", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/**
 * Create a local workspace for a headless session.
 * Clones the repo from the Docker-mounted path into a per-session directory.
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

  const workDir = join(deps.baseDir, config.sessionId);
  mkdirSync(workDir, { recursive: true });

  // Clone from local repo mount (instant, no network/auth needed)
  const cloneResult = runGit(deps, [
    "clone",
    "--branch",
    config.branch,
    "--single-branch",
    config.repoMount,
    workDir,
  ]);

  if (cloneResult.exitCode !== 0) {
    // Clean up on failure
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`,
    );
  }

  const handle: SandboxHandle = {
    sessionId: config.sessionId,
    workDir,
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
  _deps: SandboxDeps,
  sessionId: string,
): Promise<void> {
  const handle = activeSandboxes.get(sessionId);
  if (!handle) {
    return;
  }

  if (existsSync(handle.workDir)) {
    rmSync(handle.workDir, { recursive: true, force: true });
  }
  activeSandboxes.delete(sessionId);
}

/**
 * Reset internal state. Exposed for testing only.
 * @internal
 */
export function _resetForTesting(): void {
  activeSandboxes.clear();
}
