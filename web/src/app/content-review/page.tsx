"use client";

import { useState, useEffect } from "react";
import { apiFetch, apiPost } from "@/lib/api";
import type { PendingCommunication } from "@/lib/types";

export default function ContentReviewPage() {
  const [pending, setPending] = useState<PendingCommunication[]>([]);
  const [recent, setRecent] = useState<PendingCommunication[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: PendingCommunication[] }>("/api/communications/pending"),
      apiFetch<{ data: PendingCommunication[] }>("/api/communications/recent?limit=20"),
    ])
      .then(([pendRes, recentRes]) => {
        setPending(pendRes.data);
        setRecent(recentRes.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleDecide = async (id: string, decision: string, editedContent?: string) => {
    try {
      await apiPost(`/api/communications/${id}/decide`, {
        decision,
        edited_content: editedContent,
      });
      setPending((prev) => prev.filter((c) => c.id !== id));
      setEditingId(null);
    } catch {
      // Handle error
    }
  };

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">Content Review</h1>

      {/* Pending */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">No pending communications.</p>
        ) : (
          pending.map((comm) => (
            <div key={comm.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-[var(--color-accent-dim)] px-2 py-0.5 text-xs text-[var(--color-accent)]">
                    {comm.platform}
                  </span>
                  {comm.recipient && (
                    <span className="text-sm text-[var(--color-text-secondary)]">To: {comm.recipient}</span>
                  )}
                </div>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {new Date(comm.created_at).toLocaleString()}
                </span>
              </div>

              <div className="rounded bg-[var(--color-bg-primary)] p-3 text-sm whitespace-pre-wrap">
                {comm.content}
              </div>

              {editingId === comm.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    rows={4}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDecide(comm.id, "approved_edited", editContent)}
                      className="rounded px-3 py-1 text-sm bg-[var(--color-accent)] text-black hover:opacity-80"
                    >
                      Save & Approve
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded px-3 py-1 text-sm border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-card)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDecide(comm.id, "approved")}
                    className="rounded px-3 py-1 text-sm bg-[var(--color-success)] text-white hover:opacity-80"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => { setEditingId(comm.id); setEditContent(comm.content); }}
                    className="rounded px-3 py-1 text-sm bg-[var(--color-accent)] text-black hover:opacity-80"
                  >
                    Edit & Approve
                  </button>
                  <button
                    onClick={() => handleDecide(comm.id, "rejected")}
                    className="rounded px-3 py-1 text-sm bg-[var(--color-danger)] text-white hover:opacity-80"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Recently Decided */}
      {recent.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Recently Decided</h2>
          {recent.map((comm) => (
            <div key={comm.id} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-[var(--color-accent-dim)] px-2 py-0.5 text-xs text-[var(--color-accent)]">{comm.platform}</span>
                <span className="text-sm">{comm.content.slice(0, 60)}{comm.content.length > 60 ? "..." : ""}</span>
              </div>
              <span className={`text-sm ${comm.decision === "rejected" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
                {comm.decision}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
