import { readdirSync, readFileSync, existsSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { parseAgentDefinition } from "./parser.ts";
import type { AgentDefinition } from "./types.ts";
import {
  insertAgentDefinition,
  updateAgentDefinition,
  getAgentDefinition,
  getAllAgentDefinitions,
  setAgentEnabled,
} from "../db/index.ts";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 500;

export function loadAllAgentDefinitions(agentsDir: string): AgentDefinition[] {
  if (!existsSync(agentsDir)) return [];

  const defs: AgentDefinition[] = [];
  const entries = readdirSync(agentsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentMdPath = join(agentsDir, entry.name, "agent.md");
    if (!existsSync(agentMdPath)) continue;

    try {
      const content = readFileSync(agentMdPath, "utf-8");
      defs.push(parseAgentDefinition(content, agentMdPath));
    } catch (err) {
      console.error(`[fleet] failed to parse ${agentMdPath}: ${err}`);
    }
  }

  return defs;
}

export function syncDefinitionsToDb(
  db: Database,
  definitions: AgentDefinition[],
): void {
  const existingRows = getAllAgentDefinitions(db);
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const incomingIds = new Set(definitions.map((d) => d.id));

  for (const def of definitions) {
    const existing = existingById.get(def.id);

    if (!existing) {
      // Insert new definition
      insertAgentDefinition(db, {
        id: def.id,
        name: def.name,
        config_path: def.configPath,
        schedule_type: def.schedule?.type ?? null,
        schedule_expression: def.schedule?.expression ?? null,
        enabled: 1,
        next_run_at: null, // Computed by cron scheduler (task 8.5)
      });
    } else {
      // Update if changed
      const changed =
        existing.name !== def.name ||
        existing.config_path !== def.configPath ||
        existing.schedule_type !== (def.schedule?.type ?? null) ||
        existing.schedule_expression !== (def.schedule?.expression ?? null);

      if (changed) {
        updateAgentDefinition(db, def.id, {
          name: def.name,
          config_path: def.configPath,
          schedule_type: def.schedule?.type ?? null,
          schedule_expression: def.schedule?.expression ?? null,
          enabled: 1,
        });
      } else if (existing.enabled === 0) {
        // Re-enable if it was soft-disabled but file is back
        setAgentEnabled(db, def.id, true);
      }
    }
  }

  // Soft-disable definitions no longer on disk
  for (const row of existingRows) {
    if (!incomingIds.has(row.id) && row.enabled === 1) {
      setAgentEnabled(db, row.id, false);
    }
  }
}

export function watchAgentDefinitions(
  agentsDir: string,
  onChange: (defs: AgentDefinition[]) => void,
): { stop: () => void } {
  let fsWatcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function reload() {
    try {
      const defs = loadAllAgentDefinitions(agentsDir);
      onChange(defs);
    } catch (err) {
      console.error(`[fleet] error reloading agent definitions: ${err}`);
    }
  }

  function debouncedReload() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, DEBOUNCE_MS);
  }

  // Initial load
  reload();

  // Try fs.watch, fall back to polling
  try {
    fsWatcher = watch(agentsDir, { recursive: true }, (_eventType, _filename) => {
      debouncedReload();
    });
    fsWatcher.on("error", (err) => {
      console.warn(`[fleet] fs.watch error, falling back to polling: ${err}`);
      fsWatcher?.close();
      fsWatcher = null;
      startPolling();
    });
    console.log(`[fleet] watching ${agentsDir} via fs.watch`);
  } catch {
    console.warn("[fleet] fs.watch unavailable, using polling");
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(reload, POLL_INTERVAL_MS);
  }

  function stop() {
    if (fsWatcher) {
      fsWatcher.close();
      fsWatcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  return { stop };
}
