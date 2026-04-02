"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/overview", label: "Overview", icon: "OV" },
  { href: "/research", label: "Research", icon: "RE" },
  { href: "/projects", label: "Projects", icon: "PR" },
  { href: "/content-review", label: "Review", icon: "CR" },
  { href: "/automations", label: "Agents", icon: "AU" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex w-20 flex-col items-center border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-4 gap-1">
      <div className="mb-6 text-[var(--color-accent)] font-bold text-lg">OP</div>
      {tabs.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-col items-center justify-center w-14 h-14 rounded-lg text-xs transition-colors ${
              active
                ? "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-card)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            <span className="text-sm font-bold">{tab.icon}</span>
            <span className="mt-0.5">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
