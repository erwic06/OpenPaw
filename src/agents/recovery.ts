import type { Database } from "bun:sqlite";
import { getOrphanedSessions, updateSession } from "../db/index.ts";
import { updateTaskStatus } from "../plan/writer.ts";

export interface RecoveryDeps {
  db: Database;
  planPath: string;
  sendAlert: (message: string) => Promise<void>;
}

/**
 * On startup, detect orphaned sessions (started but never completed)
 * and clean them up: mark FAILED in SQLite, reset tasks to "ready",
 * send Telegram alert.
 */
export async function recoverOrphanedSessions(
  deps: RecoveryDeps,
): Promise<number> {
  const orphaned = getOrphanedSessions(deps.db);
  if (orphaned.length === 0) return 0;

  const taskIds: string[] = [];

  for (const session of orphaned) {
    updateSession(deps.db, session.id, {
      ended_at: new Date().toISOString(),
      terminal_state: "FAILED",
      error: "orchestrator restart, session orphaned",
    });

    if (session.task_id) {
      taskIds.push(session.task_id);
      try {
        await updateTaskStatus(
          deps.planPath,
          session.task_id,
          "ready",
          "prior session interrupted by restart",
        );
      } catch (err) {
        console.error(
          `[recovery] failed to reset task ${session.task_id}: ${err}`,
        );
      }
    }
  }

  const taskList = taskIds.length > 0 ? taskIds.join(", ") : "(no tasks)";
  await deps.sendAlert(
    `Restart recovery: ${orphaned.length} orphaned session(s) detected. Affected tasks: ${taskList}`,
  );

  return orphaned.length;
}
