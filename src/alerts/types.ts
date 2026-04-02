export type AlertType =
  | "session_failed"
  | "session_blocked"
  | "budget_warning"
  | "budget_hard_stop"
  | "stuck_task"
  | "orchestrator_restart"
  | "fallback_activated";

export type AlertPayload =
  | {
      type: "session_failed";
      taskId: string;
      taskTitle: string;
      agent: string;
      model: string;
      durationMs: number;
      error: string;
      costUsd: number;
    }
  | {
      type: "session_blocked";
      taskId: string;
      taskTitle: string;
      agent: string;
      model: string;
      reason: string;
    }
  | {
      type: "budget_warning";
      dailySpendUsd: number;
      dailyLimitUsd: number;
      thresholdPct: number;
    }
  | {
      type: "budget_hard_stop";
      dailySpendUsd: number;
      dailyLimitUsd: number;
    }
  | {
      type: "stuck_task";
      taskId: string;
      taskTitle: string;
      failureCount: number;
      lastError: string;
    }
  | {
      type: "orchestrator_restart";
      orphanedCount: number;
      taskIds: string[];
    }
  | {
      type: "fallback_activated";
      primaryModel: string;
      fallbackModel: string;
      taskId?: string;
      error: string;
    };

export interface AlertDeps {
  sendMessage: (
    chatId: number | string,
    text: string,
    options?: { parseMode?: "HTML" | "MarkdownV2" },
  ) => Promise<void>;
  alertsChatId?: string;
  fallbackChatId: string;
}
