"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { apiFetch, apiPost } from "@/lib/api";
import type { Project, Session, HitlGate } from "@/lib/types";
import { createWsClient } from "@/lib/ws";

interface WsEvent {
  type: string;
  data?: unknown;
  timestamp: string;
}

export default function ProjectWorkspacePage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: Project }>(`/api/projects/${id}`),
      apiFetch<{ data: Session[] }>(`/api/sessions?limit=50`),
    ])
      .then(([projRes, sessRes]) => {
        setProject(projRes.data);
        setSessions(sessRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!selectedSession) return;
    setStreamLog([]);
    const ws = createWsClient(
      `/api/ws/sessions/${selectedSession}/stream`,
      (msg: WsEvent) => {
        setStreamLog((prev) => [...prev.slice(-499), `[${msg.type}] ${JSON.stringify(msg.data)}`]);
      },
    );
    return () => ws.close();
  }, [selectedSession]);

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  if (!project) return <div className="text-[var(--color-danger)]">Project not found.</div>;

  return (
    <div className="flex h-full gap-4">
      {/* Task Sidebar */}
      <div className="w-64 shrink-0 space-y-2 overflow-auto">
        <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">{project.name}</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">{project.description}</p>
        <div className="mt-4 space-y-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedSession(s.id)}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                selectedSession === s.id
                  ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-card)]"
              }`}
            >
              <span className={`mr-2 inline-block h-2 w-2 rounded-full ${!s.ended_at ? "bg-[var(--color-accent)]" : s.terminal_state === "complete" ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`} />
              {s.agent} {s.task_id ? `(${s.task_id})` : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Session Panel */}
      <div className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] overflow-hidden flex flex-col">
        {selectedSession ? (
          <>
            <div className="border-b border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-secondary)]">
              Session: {selectedSession}
            </div>
            <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {streamLog.length === 0 ? (
                <span>Connecting to session stream...</span>
              ) : (
                streamLog.map((line, i) => <div key={i}>{line}</div>)
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-secondary)]">
            Select a session from the sidebar
          </div>
        )}
      </div>
    </div>
  );
}
