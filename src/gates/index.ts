import type { Database } from "bun:sqlite";
import { appendFileSync } from "fs";
import { createHash } from "crypto";
import type { GateRequest, GateResult } from "./types.ts";
import { GATE_TYPES, GATE_CONFIGS } from "./types.ts";
import { formatGateMessage } from "./formatter.ts";
import { insertGate, updateGate, getPendingGates as dbGetPendingGates } from "../db/index.ts";
import type { HitlGate } from "../db/types.ts";
import type { SendMessageOptions, MessageHandler } from "../messaging/index.ts";

let decisionLogPath = "/data/decisions.jsonl";

export function setDecisionLogPath(path: string): void {
  decisionLogPath = path;
}

// --- Dependency injection for testability ---

type SendFn = (
  chatId: number | string,
  text: string,
  options?: SendMessageOptions,
) => Promise<void>;

type OnMessageFn = (handler: MessageHandler) => void;

export interface GateDeps {
  db: Database;
  chatId: number;
  send: SendFn;
  onMessage: OnMessageFn;
}

// --- Module state ---

interface PendingGate {
  gateId: string;
  resolve: (result: GateResult) => void;
  feedback: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

let deps: GateDeps | null = null;
const pendingGates = new Map<string, PendingGate>();

// --- Lifecycle ---

export function initGates(d: GateDeps): void {
  deps = d;
  d.onMessage(handleMessage);
}

export function resetGates(): void {
  for (const [, pending] of pendingGates) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingGates.clear();
  deps = null;
}

// --- Gate operations ---

function generateGateId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomUUID().slice(0, 8);
  return `gate-${date}-${rand}`;
}

export async function requestApproval(request: GateRequest): Promise<GateResult> {
  if (!deps) throw new Error("[gates] not initialized — call initGates first");

  if (!(GATE_TYPES as readonly string[]).includes(request.gateType)) {
    throw new Error(`[gates] unknown gate type: ${request.gateType}`);
  }

  const gateId = generateGateId();
  const config = GATE_CONFIGS[request.gateType];
  const now = new Date().toISOString();

  insertGate(deps.db, {
    id: gateId,
    gate_type: request.gateType,
    task_id: request.taskId,
    session_id: request.sessionId,
    requested_at: now,
    context_summary: request.contextSummary,
  });

  // Register the pending gate BEFORE sending so responses arriving
  // immediately after send can be matched.
  let resolveResult!: (result: GateResult) => void;
  const resultPromise = new Promise<GateResult>((resolve) => {
    resolveResult = resolve;
  });

  const pending: PendingGate = {
    gateId,
    resolve: resolveResult,
    feedback: [],
    timer: null,
  };

  if (config.timeoutMs !== null) {
    pending.timer = setTimeout(() => {
      resolveGate(gateId, "timeout");
    }, config.timeoutMs);
  }

  pendingGates.set(gateId, pending);

  const message = formatGateMessage(
    gateId,
    request.gateType,
    config.label,
    request.contextSummary,
    request.taskId,
    request.sessionId,
  );

  try {
    await deps.send(deps.chatId, message);
  } catch (err) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingGates.delete(gateId);
    throw err;
  }

  return resultPromise;
}

function logDecision(
  db: Database,
  gateId: string,
  decision: string,
  decidedAt: string,
): void {
  try {
    const gate = db
      .prepare("SELECT gate_type, task_id, session_id, context_summary FROM hitl_gates WHERE id = ?")
      .get(gateId) as {
      gate_type: string;
      task_id: string | null;
      session_id: string | null;
      context_summary: string | null;
    } | null;

    if (!gate) return;

    const entry = {
      id: gateId,
      gate_type: gate.gate_type,
      task_id: gate.task_id,
      session_id: gate.session_id,
      decision,
      decided_at: decidedAt,
      context_summary_hash: gate.context_summary
        ? createHash("sha256").update(gate.context_summary).digest("hex")
        : null,
    };

    appendFileSync(decisionLogPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[gates] decision logging failed:", err);
  }
}

function resolveGate(gateId: string, decision: "approved" | "denied" | "timeout"): void {
  const pending = pendingGates.get(gateId);
  if (!pending) return;

  if (pending.timer) clearTimeout(pending.timer);
  pendingGates.delete(gateId);

  const decidedAt = new Date().toISOString();

  if (deps) {
    updateGate(deps.db, gateId, decision);
    logDecision(deps.db, gateId, decision, decidedAt);
  }

  pending.resolve({
    gateId,
    decision,
    feedback: pending.feedback,
    decidedAt,
  });
}

// --- Telegram message handler ---

async function handleMessage(_chatId: number, text: string): Promise<void> {
  if (!deps || pendingGates.size === 0) return;

  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return;

  const lower = trimmed.toLowerCase();

  // Extract gate ID if present (pattern: gate-YYYY-MM-DD-XXXXXXXX)
  const gateIdMatch = lower.match(/\bgate-\d{4}-\d{2}-\d{2}-[a-f0-9]+/);
  let gateId: string | null = gateIdMatch ? gateIdMatch[0] : null;

  // Determine intent
  let decision: "approved" | "denied" | null = null;
  if (/\b(approve|yes)\b/.test(lower)) decision = "approved";
  else if (/\b(deny|no)\b/.test(lower)) decision = "denied";

  // Resolve target gate
  if (!gateId) {
    if (pendingGates.size === 1) {
      gateId = pendingGates.keys().next().value!;
    } else {
      const ids = [...pendingGates.keys()].map((id) => `<code>${id}</code>`).join("\n");
      await deps.send(
        deps.chatId,
        `Multiple gates pending. Specify gate ID:\n${ids}`,
        { parseMode: "HTML" },
      );
      return;
    }
  }

  const pending = pendingGates.get(gateId);
  if (!pending) return;

  if (decision) {
    resolveGate(gateId, decision);
    const emoji = decision === "approved" ? "\u{2705}" : "\u{274C}";
    await deps.send(
      deps.chatId,
      `${emoji} Gate <code>${gateId}</code> ${decision}.`,
      { parseMode: "HTML" },
    );
  } else {
    pending.feedback.push(trimmed);
    await deps.send(
      deps.chatId,
      `\u{1F4DD} Feedback noted for gate <code>${gateId}</code>. Reply <b>approve</b> or <b>deny</b> to decide.`,
      { parseMode: "HTML" },
    );
  }
}

// --- Query ---

export function getPendingGatesList(): HitlGate[] {
  if (!deps) throw new Error("[gates] not initialized — call initGates first");
  return dbGetPendingGates(deps.db);
}

// Expose for testing
export { handleMessage as _handleMessage };
