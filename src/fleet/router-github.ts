import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type { AgentDefinition, OutputDestination } from "./types.ts";
import type { AgentOutput } from "../agents/types.ts";
import type { RoutingDeps, SpawnSyncFn } from "./router.ts";

export async function routeToGithub(
  deps: RoutingDeps,
  agentDef: AgentDefinition,
  output: AgentOutput,
  dest: OutputDestination & { type: "github" },
): Promise<void> {
  const spawnSync = deps.spawnSyncFn ?? defaultSpawnSync;
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}.md`;
  const outputDir = join(deps.repoDir, dest.path);
  const filePath = join(outputDir, filename);
  const relPath = join(dest.path, filename);

  // Build output content
  const content = buildOutputContent(agentDef, output, date);

  // Write file
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");

  // Git add, commit, push
  const commitMsg = `[agent] ${agentDef.name}: output for ${date}`;

  git(spawnSync, deps.repoDir, ["add", relPath]);
  git(spawnSync, deps.repoDir, ["commit", "-m", commitMsg]);
  git(spawnSync, deps.repoDir, ["push"]);
}

function git(spawnSync: SpawnSyncFn, cwd: string, args: string[]): void {
  const result = spawnSync(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

function defaultSpawnSync(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(args);
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function buildOutputContent(
  agentDef: AgentDefinition,
  output: AgentOutput,
  date: string,
): string {
  const status = output.terminalState === "complete" ? "Complete" : "Failed";
  const lines: string[] = [
    `# ${agentDef.name} — ${date}`,
    "",
    `**Status:** ${status}`,
    `**Cost:** $${output.costUsd.toFixed(2)}`,
    "",
  ];

  if (output.error) {
    lines.push(`## Error`, "", output.error, "");
  }

  if (output.artifacts.length > 0) {
    lines.push(`## Output`, "");
    for (const artifact of output.artifacts) {
      lines.push(artifact, "");
    }
  }

  return lines.join("\n");
}
