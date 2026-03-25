import { watch, type FSWatcher } from "fs";
import { parsePlan } from "./parser.ts";
import type { Task } from "./types.ts";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export type ReadyCallback = (tasks: Task[]) => void;

export function getReadyTasks(tasks: Task[]): Task[] {
  const statusById = new Map<string, string>();
  for (const task of tasks) {
    statusById.set(task.id, task.status);
  }

  return tasks.filter((task) => {
    if (task.status !== "ready") return false;
    if (task.dependencies.length === 0) return true;
    return task.dependencies.every((dep) => statusById.get(dep) === "complete");
  });
}

export function watchPlan(
  filePath: string,
  onReady: ReadyCallback,
): { stop: () => void } {
  let previousReadyIds = new Set<string>();
  let fsWatcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function check() {
    try {
      const file = Bun.file(filePath);
      const content = await file.text();
      const tasks = parsePlan(content);
      const ready = getReadyTasks(tasks);
      const readyIds = new Set(ready.map((t) => t.id));

      const newReady = ready.filter((t) => !previousReadyIds.has(t.id));
      previousReadyIds = readyIds;

      if (newReady.length > 0) {
        onReady(newReady);
      }
    } catch (err) {
      console.error(`[plan-reader] error reading plan: ${err}`);
    }
  }

  // Initial check
  check();

  // Try fs.watch, fall back to polling
  try {
    fsWatcher = watch(filePath, (eventType) => {
      if (eventType === "change") {
        // Debounce rapid changes (editors often write multiple times)
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(check, 500);
      }
    });
    fsWatcher.on("error", (err) => {
      console.warn(`[plan-reader] fs.watch error, falling back to polling: ${err}`);
      fsWatcher?.close();
      fsWatcher = null;
      startPolling();
    });
    console.log(`[plan-reader] watching ${filePath} via fs.watch`);
  } catch {
    console.warn("[plan-reader] fs.watch unavailable, using polling");
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(check, POLL_INTERVAL_MS);
    console.log(`[plan-reader] polling ${filePath} every ${POLL_INTERVAL_MS / 1000}s`);
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
    console.log("[plan-reader] stopped watching");
  }

  return { stop };
}
