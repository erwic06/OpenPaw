"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch, apiPost } from "@/lib/api";
import type { Session, HitlGate, DailySpend } from "@/lib/types";
import { createWsClient } from "@/lib/ws";

export default function OverviewPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [gates, setGates] = useState<HitlGate[]>([]);
  const [spend, setSpend] = useState<DailySpend | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [sessRes, gateRes, spendRes] = await Promise.all([
        apiFetch<{ data: Session[] }>("/api/sessions?limit=20"),
        apiFetch<{ data: HitlGate[] }>("/api/gates/pending"),
        apiFetch<{ data: DailySpend }>("/api/cost/daily"),
      ]);
      setSessions(sessRes.data);
      setGates(gateRes.data);
      setSpend(spendRes.data);
    } catch {
      // API not available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const ws = createWsClient("/api/ws/notifications", () => {
      fetchData();
    });
    return () => ws.close();
  }, [fetchData]);

  const handleDecide = async (gateId: string, decision: "approved" | "denied") => {
    try {
      await apiPost(`/api/gates/${gateId}/decide`, { decision });
      setGates((prev) => prev.filter((g) => g.id !== gateId));
    } catch {
      // Handle error
    }
  };

  if (loading) {
    return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  }

  const activeSessions = sessions.filter((s) => !s.ended_at);
  const budget = 50;
  const total = spend?.total ?? 0;
  const pct = budget > 0 ? (total / budget) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Spend Bar */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-[var(--color-text-secondary)]">Daily Spend</span>
          <span className="text-sm">
            <span className="text-[var(--color-accent)]">${total.toFixed(2)}</span>
            <span className="text-[var(--color-text-secondary)]"> / ${budget.toFixed(2)}</span>
            <span className="ml-2 text-[var(--color-text-secondary)]">{pct.toFixed(1)}%</span>
          </span>
        </div>
        <div className="h-2 rounded-full bg-[var(--color-bg-primary)]">
          <div
            className="h-2 rounded-full bg-[var(--color-accent)] transition-all"
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Active Sessions" value={activeSessions.length} />
        <SummaryCard label="Pending Gates" value={gates.length} accent />
        <SummaryCard label="Total Sessions" value={sessions.length} />
        <SummaryCard label="Automations" value={0} dim />
      </div>

      {/* Pending Gates */}
      {gates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Pending Gates</h2>
          {gates.map((gate) => (
            <div key={gate.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-mono text-[var(--color-accent)]">{gate.id}</span>
                  <span className="ml-2 text-sm text-[var(--color-text-secondary)]">{gate.gate_type}</span>
                  {gate.task_id && (
                    <span className="ml-2 text-sm text-[var(--color-text-secondary)]">Task {gate.task_id}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDecide(gate.id, "approved")}
                    className="rounded px-3 py-1 text-sm bg-[var(--color-success)] text-white hover:opacity-80"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleDecide(gate.id, "denied")}
                    className="rounded px-3 py-1 text-sm bg-[var(--color-danger)] text-white hover:opacity-80"
                  >
                    Deny
                  </button>
                </div>
              </div>
              {gate.context_summary && (
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{gate.context_summary}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Recent Activity */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Recent Activity</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">No recent activity.</p>
        ) : (
          sessions.slice(0, 20).map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={`h-2 w-2 rounded-full ${s.ended_at ? (s.terminal_state === "complete" ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]") : "bg-[var(--color-accent)] animate-pulse"}`} />
                <div>
                  <span className="text-sm">{s.agent}</span>
                  {s.task_id && <span className="ml-2 text-sm text-[var(--color-text-secondary)]">Task {s.task_id}</span>}
                  <span className="ml-2 text-xs text-[var(--color-text-secondary)]">{s.model}</span>
                </div>
              </div>
              <div className="flex items-center gap-4 text-sm text-[var(--color-text-secondary)]">
                {s.cost_usd !== null && <span>${s.cost_usd.toFixed(2)}</span>}
                <span>{new Date(s.started_at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent, dim }: { label: string; value: number; accent?: boolean; dim?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <div className="text-sm text-[var(--color-text-secondary)]">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent ? "text-[var(--color-accent)]" : dim ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-primary)]"}`}>
        {value}
      </div>
    </div>
  );
}
