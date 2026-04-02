"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import type { Session } from "@/lib/types";

export default function ResearchPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ data: Session[] }>("/api/sessions?limit=100")
      .then((res) => {
        setSessions(res.data.filter((s) => s.agent === "researcher"));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  const active = sessions.filter((s) => !s.ended_at);
  const completed = sessions.filter((s) => s.ended_at);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">Research</h1>

      {active.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Active</h2>
          {active.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
          Completed ({completed.length})
        </h2>
        {completed.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">No completed research tasks.</p>
        ) : (
          completed.map((s) => <SessionCard key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}

function SessionCard({ session }: { session: Session }) {
  const isActive = !session.ended_at;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${isActive ? "bg-[var(--color-accent)] animate-pulse" : session.terminal_state === "complete" ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`} />
          <span className="text-sm font-mono">{session.id.slice(0, 12)}</span>
          {session.task_id && <span className="text-sm text-[var(--color-text-secondary)]">Task {session.task_id}</span>}
        </div>
        <div className="flex items-center gap-4 text-sm text-[var(--color-text-secondary)]">
          <span>{session.model}</span>
          {session.cost_usd !== null && <span>${session.cost_usd.toFixed(2)}</span>}
          <span>{new Date(session.started_at).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}
