import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import type { Session, HitlGate, CostEntry, PendingCommunication } from "./types.ts";

const SCHEMA_PATH = import.meta.dir + "/schema.sql";

export function initDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  const schema = readFileSync(SCHEMA_PATH, "utf-8");

  db.exec("PRAGMA journal_mode=WAL");

  const statements = schema
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("PRAGMA"));
  for (const stmt of statements) {
    db.exec(stmt);
  }

  return db;
}

// --- Sessions ---

export function insertSession(db: Database, session: Omit<Session, "ended_at" | "terminal_state" | "input_tokens" | "output_tokens" | "cost_usd" | "error">): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, task_id, model, provider, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(session.id, session.agent, session.task_id, session.model, session.provider, session.started_at);
}

export function updateSession(db: Database, id: string, updates: Partial<Pick<Session, "ended_at" | "terminal_state" | "input_tokens" | "output_tokens" | "cost_usd" | "error">>): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function getSessionsByStatus(db: Database, status: string): Session[] {
  return db.prepare("SELECT * FROM sessions WHERE terminal_state = ?").all(status) as Session[];
}

export function getOrphanedSessions(db: Database): Session[] {
  return db
    .prepare("SELECT * FROM sessions WHERE ended_at IS NULL")
    .all() as Session[];
}

// --- HITL Gates ---

export function insertGate(db: Database, gate: Omit<HitlGate, "decided_at" | "decision">): void {
  db.prepare(
    `INSERT INTO hitl_gates (id, gate_type, task_id, session_id, requested_at, context_summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gate.id, gate.gate_type, gate.task_id, gate.session_id, gate.requested_at, gate.context_summary);
}

export function updateGate(db: Database, id: string, decision: string): void {
  db.prepare(
    `UPDATE hitl_gates SET decision = ?, decided_at = ? WHERE id = ?`,
  ).run(decision, new Date().toISOString(), id);
}

export function getPendingGates(db: Database): HitlGate[] {
  return db.prepare("SELECT * FROM hitl_gates WHERE decision IS NULL").all() as HitlGate[];
}

// --- Cost Log ---

export function insertCostEntry(db: Database, entry: Omit<CostEntry, "id">): void {
  db.prepare(
    `INSERT INTO cost_log (session_id, service, amount_usd, logged_at)
     VALUES (?, ?, ?, ?)`,
  ).run(entry.session_id, entry.service, entry.amount_usd, entry.logged_at);
}

export function getDailySpend(db: Database, date: string): number {
  const result = db.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) as total FROM cost_log
     WHERE date(logged_at) = date(?)`,
  ).get(date) as { total: number };
  return result.total;
}

// --- Pending Communications ---

export function insertPendingCommunication(db: Database, comm: Omit<PendingCommunication, "decided_at" | "decision" | "edited_content">): void {
  db.prepare(
    `INSERT INTO pending_communications (id, gate_id, agent_id, platform, recipient, content_type, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(comm.id, comm.gate_id, comm.agent_id, comm.platform, comm.recipient, comm.content_type, comm.content, comm.metadata, comm.created_at);
}

export function updatePendingCommunication(db: Database, id: string, decision: string, editedContent?: string): void {
  db.prepare(
    `UPDATE pending_communications SET decision = ?, decided_at = ?, edited_content = ? WHERE id = ?`,
  ).run(decision, new Date().toISOString(), editedContent ?? null, id);
}

export function getPendingCommunications(db: Database): PendingCommunication[] {
  return db.prepare("SELECT * FROM pending_communications WHERE decision IS NULL").all() as PendingCommunication[];
}
