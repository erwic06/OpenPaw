"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";

export function Header() {
  const [dailySpend, setDailySpend] = useState<number | null>(null);
  const [commandInput, setCommandInput] = useState("");

  useEffect(() => {
    apiFetch<{ data: { total: number } }>("/api/cost/daily")
      .then((res) => setDailySpend(res.data.total))
      .catch(() => setDailySpend(null));
  }, []);

  return (
    <header className="flex items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-3">
      <input
        type="text"
        placeholder="Ask anything or give a task..."
        value={commandInput}
        onChange={(e) => setCommandInput(e.target.value)}
        className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] whitespace-nowrap">
        <span className="text-[var(--color-accent)]">$</span>
        <span>{dailySpend !== null ? dailySpend.toFixed(2) : "--"}</span>
        <span className="text-[var(--color-text-secondary)]">/ $50</span>
      </div>
    </header>
  );
}
