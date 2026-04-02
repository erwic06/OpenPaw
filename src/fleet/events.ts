import { watch, existsSync, type FSWatcher } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { AgentDefinition } from "./types.ts";
import { getLatestAgentRun } from "../db/index.ts";

export interface EventTriggerDeps {
  db: Database;
  triggerAgent: (
    def: AgentDefinition,
    triggeredBy: string,
    detail: string,
  ) => Promise<void>;
  repoDir: string;
}

export class EventTriggerSystem {
  private deps: EventTriggerDeps;
  private commitWatchers = new Map<string, FSWatcher>();
  private eventDefs = new Map<string, AgentDefinition[]>();

  constructor(deps: EventTriggerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.setupCommitWatchers();
  }

  stop(): void {
    for (const [, watcher] of this.commitWatchers) {
      watcher.close();
    }
    this.commitWatchers.clear();
  }

  updateDefinitions(defs: AgentDefinition[]): void {
    // Rebuild the event registry
    this.eventDefs.clear();

    for (const def of defs) {
      if (def.schedule?.type !== "event" || !def.schedule.expression) continue;
      const key = def.schedule.expression;
      const existing = this.eventDefs.get(key) ?? [];
      existing.push(def);
      this.eventDefs.set(key, existing);
    }

    // Restart commit watchers with new definitions
    this.stop();
    this.setupCommitWatchers();
  }

  emit(eventType: string, detail: string): void {
    // Find matching definitions
    const exact = this.eventDefs.get(`${eventType}:${detail}`) ?? [];
    const wildcard = this.eventDefs.get(`${eventType}:*`) ?? [];
    const matches = [...exact, ...wildcard];

    // Also check pattern matches for on_task_complete
    if (eventType === "on_task_complete") {
      for (const [key, defs] of this.eventDefs) {
        if (!key.startsWith("on_task_complete:")) continue;
        const pattern = key.slice("on_task_complete:".length);
        if (pattern !== detail && pattern !== "*" && matchGlob(pattern, detail)) {
          matches.push(...defs);
        }
      }
    }

    for (const def of matches) {
      this.triggerIfNotRunning(def, eventType, detail);
    }
  }

  private setupCommitWatchers(): void {
    const branches = new Set<string>();

    for (const [key] of this.eventDefs) {
      if (key.startsWith("on_commit:")) {
        branches.add(key.slice("on_commit:".length));
      }
    }

    for (const branch of branches) {
      const refPath = join(this.deps.repoDir, ".git", "refs", "heads", branch);
      if (!existsSync(refPath)) {
        console.warn(`[events] git ref not found: ${refPath}, skipping watcher`);
        continue;
      }

      try {
        const watcher = watch(refPath, () => {
          this.emit("on_commit", branch);
        });
        this.commitWatchers.set(branch, watcher);
      } catch (err) {
        console.warn(`[events] failed to watch ${refPath}: ${err}`);
      }
    }
  }

  private triggerIfNotRunning(
    def: AgentDefinition,
    eventType: string,
    detail: string,
  ): void {
    // Deduplication: skip if agent is already running
    const latestRun = getLatestAgentRun(this.deps.db, def.id);
    if (latestRun && latestRun.status === "running") {
      console.log(
        `[events] skipping ${def.id}: already running (run ${latestRun.id})`,
      );
      return;
    }

    this.deps
      .triggerAgent(def, "event", `${eventType}:${detail}`)
      .catch((err) => {
        console.error(`[events] trigger failed for ${def.id}: ${err}`);
      });
  }
}

/**
 * Simple glob matching: supports trailing * (e.g., "6.*" matches "6.1", "6.2").
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}
