import type { Database } from "bun:sqlite";
import type { AgentDefinition } from "./types.ts";
import type { AgentInput, AgentOutput } from "../agents/types.ts";
import type { BudgetEnforcer } from "../budget/index.ts";
import { createWsMessage } from "../api/index.ts";
import type { NanoClawEvents } from "../api/index.ts";
import { loadAllAgentDefinitions, syncDefinitionsToDb, watchAgentDefinitions } from "./loader.ts";
import { CronScheduler } from "./scheduler.ts";
import { EventTriggerSystem } from "./events.ts";
import { routeOutput } from "./router.ts";
import type { RoutingDeps, SendMessageFn, SpawnSyncFn } from "./router.ts";
import { ServiceAdapter } from "../agents/service-adapter.ts";
import type { ServiceAdapterConfig } from "../agents/service-adapter.ts";
import { insertAgentRun, updateAgentRun } from "../db/index.ts";

export interface FleetOrchestratorDeps {
  db: Database;
  secrets: Map<string, string>;
  sendMessage: SendMessageFn;
  chatId: string;
  repoDir: string;
  agentsDir: string;
  alertSystem?: { send: (msg: string) => Promise<void> };
  budgetEnforcer?: BudgetEnforcer;
  events?: NanoClawEvents;
  spawnSyncFn?: SpawnSyncFn;
}

export class FleetOrchestrator {
  private deps: FleetOrchestratorDeps;
  private scheduler: CronScheduler;
  private eventSystem: EventTriggerSystem;
  private watcher: { stop: () => void } | null = null;
  private activeRuns = new Set<string>();

  constructor(deps: FleetOrchestratorDeps) {
    this.deps = deps;

    const triggerFn = this.triggerAgent.bind(this);

    this.scheduler = new CronScheduler({
      db: deps.db,
      triggerAgent: triggerFn,
    });

    this.eventSystem = new EventTriggerSystem({
      db: deps.db,
      triggerAgent: triggerFn,
      repoDir: deps.repoDir,
    });
  }

  start(): void {
    // Load and sync definitions
    const defs = loadAllAgentDefinitions(this.deps.agentsDir);
    syncDefinitionsToDb(this.deps.db, defs);
    this.scheduler.updateSchedule(defs);
    this.eventSystem.updateDefinitions(defs);

    // Start subsystems
    this.scheduler.start();
    this.eventSystem.start();

    // Watch for definition changes
    this.watcher = watchAgentDefinitions(this.deps.agentsDir, (updated) => {
      syncDefinitionsToDb(this.deps.db, updated);
      this.scheduler.updateSchedule(updated);
      this.eventSystem.updateDefinitions(updated);
    });

    console.log(`[fleet] orchestrator started, ${defs.length} definition(s) loaded`);
  }

  stop(): void {
    this.scheduler.stop();
    this.eventSystem.stop();
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    console.log("[fleet] orchestrator stopped");
  }

  getEventSystem(): EventTriggerSystem {
    return this.eventSystem;
  }

  getScheduler(): CronScheduler {
    return this.scheduler;
  }

  async triggerAgent(
    def: AgentDefinition,
    triggeredBy: string,
    detail: string,
  ): Promise<void> {
    const runId = `run-${crypto.randomUUID()}`;

    // Budget check
    if (this.deps.budgetEnforcer) {
      const allowed = await this.deps.budgetEnforcer.enforceBudget();
      if (!allowed) {
        console.warn(`[fleet] budget exceeded, skipping ${def.id}`);
        return;
      }
    }

    // Insert agent_runs row
    insertAgentRun(this.deps.db, {
      id: runId,
      agent_id: def.id,
      session_id: null,
      triggered_by: triggeredBy === "manual" ? "manual" : triggeredBy === "event" ? "event" : "schedule",
      trigger_detail: detail,
      started_at: new Date().toISOString(),
    });

    // Set status to running
    updateAgentRun(this.deps.db, runId, { status: "running" });

    this.activeRuns.add(runId);

    // Emit start event
    this.deps.events?.emit("fleet", createWsMessage("session_started", { agentId: def.id, runId }));

    try {
      const output = await this.executeAgent(def, runId);

      // Route output
      const routingDeps: RoutingDeps = {
        sendMessage: this.deps.sendMessage,
        chatId: this.deps.chatId,
        repoDir: this.deps.repoDir,
        spawnSyncFn: this.deps.spawnSyncFn,
      };
      const routingResults = await routeOutput(routingDeps, def, output);

      // Update agent_runs with final status
      updateAgentRun(this.deps.db, runId, {
        status: output.terminalState === "complete" ? "complete" : "failed",
        ended_at: new Date().toISOString(),
        output_routed_to: JSON.stringify(routingResults),
      });

      this.deps.events?.emit("fleet", createWsMessage("session_completed", {
        agentId: def.id,
        runId,
        status: output.terminalState,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[fleet] agent ${def.id} failed: ${errorMsg}`);

      updateAgentRun(this.deps.db, runId, {
        status: "failed",
        ended_at: new Date().toISOString(),
      });

      this.deps.events?.emit("fleet", createWsMessage("session_failed", {
        agentId: def.id,
        runId,
      }));
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async executeAgent(
    def: AgentDefinition,
    runId: string,
  ): Promise<AgentOutput> {
    if (def.adapterConfig.type === "service") {
      return this.executeServiceAgent(def, runId);
    }

    // LLM adapter — for now, return a placeholder since the specific
    // adapter selection (LLM/Codex/Gemini) requires the full SessionRunner
    // infrastructure. Fleet agents using LLM adapters will be wired through
    // the existing adapters in a future iteration.
    throw new Error(
      `LLM fleet agents not yet wired (agent ${def.id}). Use service adapter or trigger via cron.`,
    );
  }

  private async executeServiceAgent(
    def: AgentDefinition,
    runId: string,
  ): Promise<AgentOutput> {
    const config = def.adapterConfig as {
      type: "service";
      baseUrl: string;
      auth: string;
      healthCheck: string;
      triggerEndpoint: string;
      statusEndpoint: string;
      outputEndpoint: string;
    };

    const serviceConfig: ServiceAdapterConfig = {
      baseUrl: config.baseUrl,
      auth: config.auth,
      healthCheck: config.healthCheck,
      triggerEndpoint: config.triggerEndpoint,
      statusEndpoint: config.statusEndpoint,
      outputEndpoint: config.outputEndpoint,
    };

    const adapter = new ServiceAdapter({
      db: this.deps.db,
      config: serviceConfig,
      secrets: this.deps.secrets,
    });

    // Health check
    const healthy = await adapter.healthCheck();
    if (!healthy) {
      throw new Error(`Service ${config.baseUrl} health check failed`);
    }

    // Build input
    const input: AgentInput = {
      taskId: runId,
      taskTitle: def.name,
      contractPath: def.configPath,
      systemPromptPath: null,
      modelTier: "standard",
      tools: def.tools.map((t) => t.name),
      budgetUsd: def.budgetPerRun,
    };

    // Trigger
    const sessionId = await adapter.trigger(input);

    // Update run with session ID
    updateAgentRun(this.deps.db, runId, { session_id: sessionId });

    // Poll for completion
    const maxPolls = 360; // 30 minutes at 5s intervals
    const pollInterval = 5000;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollInterval);
      const status = await adapter.status(sessionId);
      if (status === "complete" || status === "failed") {
        return adapter.output(sessionId);
      }
    }

    // Timed out
    throw new Error(`Agent ${def.id} timed out after 30 minutes`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
