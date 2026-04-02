import type { Database } from "bun:sqlite";
import type { AgentDefinition } from "./types.ts";
import { matchesCron, nextCronTime } from "./cron.ts";
import {
  getEnabledAgentDefinitions,
  getAgentDefinition,
  updateAgentLastRun,
  updateAgentNextRun,
} from "../db/index.ts";

const TICK_INTERVAL_MS = 60_000; // 60 seconds

export interface SchedulerDeps {
  db: Database;
  triggerAgent: (
    def: AgentDefinition,
    triggeredBy: string,
    detail: string,
  ) => Promise<void>;
  now?: () => Date;
}

export class CronScheduler {
  private deps: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private definitions: AgentDefinition[] = [];

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Run first tick immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateSchedule(definitions: AgentDefinition[]): void {
    this.definitions = definitions;

    // Update next_run_at for cron definitions
    const now = this.now();
    for (const def of definitions) {
      if (def.schedule?.type === "cron" && def.schedule.expression) {
        try {
          const next = nextCronTime(def.schedule.expression, now);
          updateAgentNextRun(this.deps.db, def.id, next.toISOString());
        } catch {
          // Invalid cron expression — skip
        }
      }
    }
  }

  async triggerManual(agentId: string): Promise<void> {
    const def = this.definitions.find((d) => d.id === agentId);
    if (!def) {
      throw new Error(`Agent definition not found: ${agentId}`);
    }

    const now = this.now();
    updateAgentLastRun(this.deps.db, def.id, now.toISOString());
    await this.deps.triggerAgent(def, "manual", "manual trigger");
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const rows = getEnabledAgentDefinitions(this.deps.db);

    for (const row of rows) {
      if (row.schedule_type !== "cron" || !row.schedule_expression) continue;

      // Check if expression matches current time
      if (!matchesCron(row.schedule_expression, now)) continue;

      // Idempotent: skip if already ran in this cron minute
      if (row.last_run_at) {
        const lastRun = new Date(row.last_run_at);
        if (
          lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getMinutes() === now.getMinutes()
        ) {
          continue; // Already fired in this minute
        }
      }

      // Find the full AgentDefinition from in-memory list
      const def = this.definitions.find((d) => d.id === row.id);
      if (!def) continue;

      // Update last_run_at and next_run_at
      updateAgentLastRun(this.deps.db, def.id, now.toISOString());
      try {
        const next = nextCronTime(def.schedule!.expression!, now);
        updateAgentNextRun(this.deps.db, def.id, next.toISOString());
      } catch {
        // Skip next_run_at computation error
      }

      // Fire trigger (don't await — don't block the tick loop)
      this.deps.triggerAgent(def, "schedule", row.schedule_expression).catch(
        (err) => {
          console.error(`[scheduler] trigger failed for ${def.id}: ${err}`);
        },
      );
    }
  }
}
