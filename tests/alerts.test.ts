import { describe, test, expect, mock } from "bun:test";
import {
  formatAlertMessage,
  AlertSystem,
  type AlertPayload,
  type AlertDeps,
} from "../src/alerts/index.ts";

// --- formatAlertMessage ---

describe("formatAlertMessage", () => {
  test("session_failed includes all fields and footer", () => {
    const payload: AlertPayload = {
      type: "session_failed",
      taskId: "2.3",
      taskTitle: "Implement auth middleware",
      agent: "Coder",
      model: "claude-sonnet-4-6",
      durationMs: 720_000,
      error: "Tests failing — 3/7 pass, auth_refresh_test timeout",
      costUsd: 1.24,
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>SESSION FAILED</b>");
    expect(html).toContain("<b>Task:</b> 2.3 \u2014 Implement auth middleware");
    expect(html).toContain("<b>Agent:</b> Coder (claude-sonnet-4-6)");
    expect(html).toContain("<b>Duration:</b> 12m");
    expect(html).toContain("<b>Error:</b>");
    expect(html).toContain("<b>Cost:</b> $1.24");
    expect(html).toContain("\u2192 Task marked FAILED");
  });

  test("session_blocked includes reason and footer", () => {
    const payload: AlertPayload = {
      type: "session_blocked",
      taskId: "3.1",
      taskTitle: "Agent types",
      agent: "Coder",
      model: "claude-opus-4-6",
      reason: "project_spec.md needs modification",
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>SESSION BLOCKED</b>");
    expect(html).toContain("<b>Reason:</b>");
    expect(html).toContain("\u2192 Task marked BLOCKED");
  });

  test("budget_warning includes threshold", () => {
    const payload: AlertPayload = {
      type: "budget_warning",
      dailySpendUsd: 40.0,
      dailyLimitUsd: 50.0,
      thresholdPct: 80,
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>BUDGET WARNING</b>");
    expect(html).toContain("<b>Daily Spend:</b> $40.00");
    expect(html).toContain("<b>Daily Limit:</b> $50.00");
    expect(html).toContain("<b>Threshold:</b> 80%");
    expect(html).toContain("\u2192 Approaching daily budget limit.");
  });

  test("budget_hard_stop includes spend and limit", () => {
    const payload: AlertPayload = {
      type: "budget_hard_stop",
      dailySpendUsd: 50.0,
      dailyLimitUsd: 50.0,
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>BUDGET HARD STOP</b>");
    expect(html).toContain("<b>Daily Spend:</b> $50.00");
    expect(html).toContain("\u2192 Daily budget exhausted.");
  });

  test("stuck_task includes failure count", () => {
    const payload: AlertPayload = {
      type: "stuck_task",
      taskId: "4.2",
      taskTitle: "Gemini adapter",
      failureCount: 3,
      lastError: "Rate limited after 2 retries",
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>STUCK TASK</b>");
    expect(html).toContain("<b>Failures:</b> 3");
    expect(html).toContain("<b>Last Error:</b>");
    expect(html).toContain("\u2192 Task paused");
  });

  test("orchestrator_restart includes orphaned count and task IDs", () => {
    const payload: AlertPayload = {
      type: "orchestrator_restart",
      orphanedCount: 2,
      taskIds: ["3.5", "3.6"],
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>ORCHESTRATOR RESTART</b>");
    expect(html).toContain("<b>Orphaned Sessions:</b> 2");
    expect(html).toContain("<b>Tasks:</b> 3.5, 3.6");
    expect(html).toContain("\u2192 Orphaned sessions marked FAILED");
  });

  test("fallback_activated includes primary and fallback models", () => {
    const payload: AlertPayload = {
      type: "fallback_activated",
      primaryModel: "claude-sonnet-4-6",
      fallbackModel: "gpt-5.4",
      taskId: "3.7",
      error: "Rate limited",
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>FALLBACK ACTIVATED</b>");
    expect(html).toContain("<b>Primary:</b> claude-sonnet-4-6");
    expect(html).toContain("<b>Fallback:</b> gpt-5.4");
    expect(html).toContain("<b>Task:</b> 3.7");
    expect(html).toContain("<b>Error:</b> Rate limited");
    expect(html).toContain("\u2192 Switched to fallback model.");
  });

  test("fallback_activated omits task field when taskId is undefined", () => {
    const payload: AlertPayload = {
      type: "fallback_activated",
      primaryModel: "claude-sonnet-4-6",
      fallbackModel: "gpt-5.4",
      error: "Service unavailable",
    };
    const html = formatAlertMessage(payload);
    expect(html).not.toContain("<b>Task:</b>");
  });

  test("escapes HTML in user-provided fields", () => {
    const payload: AlertPayload = {
      type: "session_failed",
      taskId: "1.1",
      taskTitle: "Test <script>alert('xss')</script>",
      agent: "Coder",
      model: "claude-sonnet-4-6",
      durationMs: 60_000,
      error: "Error with <b>bold</b> & ampersand",
      costUsd: 0.5,
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; ampersand");
    expect(html).not.toContain("<script>");
  });

  test("session_failed with sub-minute duration shows <1m", () => {
    const payload: AlertPayload = {
      type: "session_failed",
      taskId: "1.1",
      taskTitle: "Quick fail",
      agent: "Coder",
      model: "claude-sonnet-4-6",
      durationMs: 20_000,
      error: "Immediate failure",
      costUsd: 0.01,
    };
    const html = formatAlertMessage(payload);
    expect(html).toContain("<b>Duration:</b> &lt;1m");
  });
});

// --- AlertSystem ---

describe("AlertSystem", () => {
  function makeDeps(overrides?: Partial<AlertDeps>): AlertDeps {
    return {
      sendMessage: mock(() => Promise.resolve()),
      fallbackChatId: "123456",
      ...overrides,
    };
  }

  test("send uses alertsChatId when provided", async () => {
    const deps = makeDeps({ alertsChatId: "999" });
    const system = new AlertSystem(deps);

    await system.send({
      type: "budget_hard_stop",
      dailySpendUsd: 50,
      dailyLimitUsd: 50,
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = (deps.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    expect(chatId).toBe("999");
    expect(text).toContain("<b>BUDGET HARD STOP</b>");
    expect(options).toEqual({ parseMode: "HTML" });
  });

  test("send falls back to fallbackChatId when alertsChatId is absent", async () => {
    const deps = makeDeps();
    const system = new AlertSystem(deps);

    await system.send({
      type: "orchestrator_restart",
      orphanedCount: 1,
      taskIds: ["2.1"],
    });

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId] = (deps.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    expect(chatId).toBe("123456");
  });

  test("send passes formatted HTML to sendMessage", async () => {
    const deps = makeDeps();
    const system = new AlertSystem(deps);

    await system.send({
      type: "session_failed",
      taskId: "2.3",
      taskTitle: "Auth middleware",
      agent: "Coder",
      model: "claude-sonnet-4-6",
      durationMs: 300_000,
      error: "Test failure",
      costUsd: 1.5,
    });

    const [, text] = (deps.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    expect(text).toContain("<b>SESSION FAILED</b>");
    expect(text).toContain("<b>Cost:</b> $1.50");
  });

  test("send propagates sendMessage errors", async () => {
    const deps = makeDeps({
      sendMessage: mock(() => Promise.reject(new Error("network error"))),
    });
    const system = new AlertSystem(deps);

    await expect(
      system.send({
        type: "budget_hard_stop",
        dailySpendUsd: 50,
        dailyLimitUsd: 50,
      }),
    ).rejects.toThrow("network error");
  });
});
