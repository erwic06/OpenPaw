import type { AgentDefinition, OutputDestination } from "./types.ts";
import type { AgentOutput } from "../agents/types.ts";
import { routeToTelegram } from "./router-telegram.ts";
import { routeToGithub } from "./router-github.ts";

export type SendMessageFn = (chatId: string, text: string) => Promise<void>;

export type SpawnSyncFn = (args: string[]) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface RoutingDeps {
  sendMessage: SendMessageFn;
  chatId: string;
  repoDir: string;
  spawnSyncFn?: SpawnSyncFn;
}

export interface RoutingResult {
  destination: string;
  success: boolean;
  error?: string;
}

export async function routeOutput(
  deps: RoutingDeps,
  agentDef: AgentDefinition,
  output: AgentOutput,
): Promise<RoutingResult[]> {
  const results: RoutingResult[] = [];

  for (const dest of agentDef.outputDestinations) {
    try {
      await routeOne(deps, agentDef, output, dest);
      results.push({
        destination: destinationLabel(dest),
        success: true,
      });
    } catch (err) {
      results.push({
        destination: destinationLabel(dest),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function routeOne(
  deps: RoutingDeps,
  agentDef: AgentDefinition,
  output: AgentOutput,
  dest: OutputDestination,
): Promise<void> {
  switch (dest.type) {
    case "telegram":
      await routeToTelegram(deps, agentDef, output, dest);
      break;
    case "github":
      await routeToGithub(deps, agentDef, output, dest);
      break;
    case "webapp":
      // No-op: webapp reads from agent_runs/sessions tables via API
      break;
  }
}

function destinationLabel(dest: OutputDestination): string {
  if (dest.type === "github") return `github:${dest.path}`;
  return dest.type;
}
