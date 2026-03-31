/** Dependencies injected into sandbox manager for testability. */
export interface SandboxDeps {
  baseDir: string;
  /** Override for testing — replaces Bun.spawnSync. */
  spawnSyncFn?: (args: string[]) => { exitCode: number; stdout: string; stderr: string };
}

/** Parameters for creating a new sandbox. */
export interface SandboxConfig {
  sessionId: string;
  repoMount: string;
  branch: string;
}

/** Handle to an active local workspace for a headless session. */
export interface SandboxHandle {
  sessionId: string;
  workDir: string;
}
