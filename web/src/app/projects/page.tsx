"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ data: Project[] }>("/api/projects")
      .then((res) => setProjects(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--color-text-secondary)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">Projects</h1>

      {projects.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">No projects yet.</p>
      ) : (
        <div className="grid gap-4">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 hover:border-[var(--color-accent)] transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold">{p.name}</h3>
                  {p.description && (
                    <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{p.description}</p>
                  )}
                </div>
                <span className="text-sm text-[var(--color-accent)]">Open &rarr;</span>
              </div>
              <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                Created {new Date(p.created_at).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
