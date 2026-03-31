import type { Database } from "bun:sqlite";
import { updateSession } from "../db/index.ts";

const HUNG_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const CHECK_INTERVAL_MS = 60_000; // 60 seconds

export interface MonitorDeps {
  cancelSession: (sessionId: string) => Promise<void>;
  db: Database;
  sendAlert: (message: string) => Promise<void>;
  /** Override for testing. */
  now?: () => number;
  /** Optional: get real activity time from adapter. Falls back to internal tracking. */
  getLastActivityMs?: (sessionId: string) => number | undefined;
}

export class SessionMonitor {
  private sessions = new Map<string, number>(); // sessionId -> lastActivityMs
  private interval: Timer | null = null;
  private deps: MonitorDeps;

  constructor(deps: MonitorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  startMonitoring(sessionId: string): void {
    const now = this.deps.now?.() ?? Date.now();
    this.sessions.set(sessionId, now);
  }

  stopMonitoring(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  recordActivity(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    const now = this.deps.now?.() ?? Date.now();
    this.sessions.set(sessionId, now);
  }

  /** Visible for testing. */
  getTrackedSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /** Run the hung-session check. Exposed for testing (normally called by setInterval). */
  async check(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();

    for (const [sessionId, lastActive] of this.sessions) {
      const realLastActive = this.deps.getLastActivityMs?.(sessionId) ?? lastActive;
      if (now - realLastActive > HUNG_THRESHOLD_MS) {
        await this.handleHung(sessionId);
      }
    }
  }

  private async handleHung(sessionId: string): Promise<void> {
    // Remove from tracking before async work to prevent duplicate handling
    this.sessions.delete(sessionId);

    try {
      await this.deps.cancelSession(sessionId);
    } catch {
      // Session may already be finished; continue with cleanup
    }

    updateSession(this.deps.db, sessionId, {
      ended_at: new Date().toISOString(),
      terminal_state: "failed",
      error: "Session hung -- no output for 10 minutes",
    });

    await this.deps.sendAlert(
      `Session ${sessionId} hung -- no output for 10 minutes. Killed and marked FAILED.`,
    );
  }
}
