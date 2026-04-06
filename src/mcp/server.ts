import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.NANOCLAW_URL ?? "http://localhost:9999";

async function api(path: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

function ok(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function safeFetch(path: string, opts?: RequestInit) {
  try {
    return await api(path, opts);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      throw new Error("NanoClaw not reachable — is the daemon running?");
    }
    throw e;
  }
}

const server = new McpServer({
  name: "openpaw",
  version: "0.1.0",
});

// --- fleet_status (composite dashboard) ---
server.tool(
  "fleet_status",
  "Dashboard overview: health, active sessions, pending gates, pending comms, today's spend",
  async () => {
    try {
      const [health, sessions, gates, cost, comms] = await Promise.allSettled([
        fetch(`${BASE_URL}/health`).then((r) => (r.ok ? "ok" : "unhealthy")),
        api("/api/sessions?active=true"),
        api("/api/gates/pending"),
        api("/api/cost/daily"),
        api("/api/communications/pending"),
      ]);

      return ok({
        health: health.status === "fulfilled" ? health.value : "unreachable",
        activeSessions: sessions.status === "fulfilled" ? sessions.value : { error: sessions.reason?.message },
        pendingGates: gates.status === "fulfilled" ? gates.value : { error: gates.reason?.message },
        dailyCost: cost.status === "fulfilled" ? cost.value : { error: cost.reason?.message },
        pendingComms: comms.status === "fulfilled" ? comms.value : { error: comms.reason?.message },
      });
    } catch {
      return err("NanoClaw not reachable — is the daemon running?");
    }
  },
);

// --- list_sessions ---
server.tool(
  "list_sessions",
  "List recent agent sessions",
  { active: z.boolean().optional().describe("Filter to active sessions only") },
  async ({ active }) => {
    try {
      const path = active ? "/api/sessions?active=true" : "/api/sessions";
      return ok(await safeFetch(path));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- get_session ---
server.tool(
  "get_session",
  "Get session detail and cost",
  { id: z.string().describe("Session ID") },
  async ({ id }) => {
    try {
      const [session, cost] = await Promise.all([
        safeFetch(`/api/sessions/${id}`),
        safeFetch(`/api/cost/session/${id}`),
      ]);
      return ok({ session, cost });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- list_gates ---
server.tool(
  "list_gates",
  "List pending HITL approval gates",
  async () => {
    try {
      return ok(await safeFetch("/api/gates/pending"));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- decide_gate ---
server.tool(
  "decide_gate",
  "Approve or deny a pending gate",
  {
    id: z.string().describe("Gate ID"),
    decision: z.enum(["approved", "denied"]).describe("Decision"),
    feedback: z.string().optional().describe("Optional feedback"),
  },
  async ({ id, decision, feedback }) => {
    try {
      return ok(
        await safeFetch(`/api/gates/${id}/decide`, {
          method: "POST",
          body: JSON.stringify({ decision, feedback }),
        }),
      );
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- create_task ---
server.tool(
  "create_task",
  "Dispatch a coding or research task",
  {
    type: z.enum(["research", "coding"]).describe("Task type"),
    prompt: z.string().describe("Task description"),
    depth: z.number().int().min(1).max(10).optional().describe("Research depth (1-10, research only)"),
    projectName: z.string().optional().describe("Project name (required for coding tasks)"),
  },
  async ({ type, prompt, depth, projectName }) => {
    try {
      return ok(
        await safeFetch("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ type, prompt, depth, projectName }),
        }),
      );
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- get_task ---
server.tool(
  "get_task",
  "Get task detail from implementation plan",
  { id: z.string().describe("Task ID (e.g. '2.1')") },
  async ({ id }) => {
    try {
      return ok(await safeFetch(`/api/tasks/${id}`));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- get_daily_cost ---
server.tool(
  "get_daily_cost",
  "Get daily cost breakdown",
  { date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)") },
  async ({ date }) => {
    try {
      const path = date ? `/api/cost/daily?date=${date}` : "/api/cost/daily";
      return ok(await safeFetch(path));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- list_projects ---
server.tool(
  "list_projects",
  "List all projects",
  async () => {
    try {
      return ok(await safeFetch("/api/projects"));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- list_pending_comms ---
server.tool(
  "list_pending_comms",
  "List pending outbound communications awaiting approval",
  async () => {
    try {
      return ok(await safeFetch("/api/communications/pending"));
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- decide_communication ---
server.tool(
  "decide_communication",
  "Approve, edit, or reject a pending outbound communication",
  {
    id: z.string().describe("Communication ID"),
    decision: z.enum(["approved", "approved_edited", "rejected"]).describe("Decision"),
    edited_content: z.string().optional().describe("Edited content (required for approved_edited)"),
  },
  async ({ id, decision, edited_content }) => {
    try {
      return ok(
        await safeFetch(`/api/communications/${id}/decide`, {
          method: "POST",
          body: JSON.stringify({ decision, edited_content }),
        }),
      );
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
