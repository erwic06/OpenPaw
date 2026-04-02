import { describe, test, expect, beforeEach } from "bun:test";
import { createRouter } from "../src/api/router.ts";
import { allRoutes } from "../src/api/routes/index.ts";
import { initDatabase, insertSession, insertGate, insertCostEntry, insertProject, insertPendingCommunication } from "../src/db/index.ts";
import type { ApiDeps } from "../src/api/types.ts";

let db: ReturnType<typeof initDatabase>;
let router: (req: Request) => Response | Promise<Response>;

beforeEach(() => {
  db = initDatabase(":memory:");
  const deps: ApiDeps = {
    db,
    resolveGateFn: async (gateId, decision, feedback) => {
      const gate = db.prepare("SELECT * FROM hitl_gates WHERE id = ?").get(gateId) as any;
      if (!gate) return { success: false, error: "gate not found" };
      if (gate.decision) return { success: false, error: "gate already decided" };
      db.prepare("UPDATE hitl_gates SET decision = ?, decided_at = ? WHERE id = ?")
        .run(decision, new Date().toISOString(), gateId);
      return { success: true };
    },
  };
  router = createRouter(allRoutes(), deps);
});

function get(path: string): Promise<Response> {
  return router(new Request(`http://localhost${path}`));
}

function post(path: string, body: unknown): Promise<Response> {
  return router(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// --- Health ---

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// --- Sessions ---

describe("GET /api/sessions", () => {
  test("returns empty list when no sessions", async () => {
    const res = await get("/api/sessions");
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test("returns recent sessions", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: "3.1", model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    insertSession(db, { id: "s2", agent: "researcher", task_id: "4.1", model: "gemini", provider: "google", started_at: "2026-04-01T11:00:00Z" });
    const res = await get("/api/sessions");
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("s2"); // most recent first
  });

  test("respects limit param", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: null, model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    insertSession(db, { id: "s2", agent: "coder", task_id: null, model: "sonnet", provider: "anthropic", started_at: "2026-04-01T11:00:00Z" });
    const res = await get("/api/sessions?limit=1");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });
});

describe("GET /api/sessions/:id", () => {
  test("returns session by id", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: "3.1", model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    const res = await get("/api/sessions/s1");
    const body = await res.json();
    expect(body.data.id).toBe("s1");
    expect(body.data.agent).toBe("coder");
  });

  test("returns 404 for unknown session", async () => {
    const res = await get("/api/sessions/unknown");
    expect(res.status).toBe(404);
  });
});

// --- Gates ---

describe("GET /api/gates/pending", () => {
  test("returns pending gates", async () => {
    insertGate(db, { id: "g1", gate_type: "deploy", task_id: "3.1", session_id: "s1", requested_at: "2026-04-01T10:00:00Z", context_summary: "deploy to prod" });
    const res = await get("/api/gates/pending");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("g1");
  });
});

describe("POST /api/gates/:id/decide", () => {
  test("approves a gate", async () => {
    insertGate(db, { id: "g1", gate_type: "deploy", task_id: "3.1", session_id: "s1", requested_at: "2026-04-01T10:00:00Z", context_summary: "test" });
    const res = await post("/api/gates/g1/decide", { decision: "approved" });
    const body = await res.json();
    expect(body.data.decision).toBe("approved");
  });

  test("returns 400 for invalid decision", async () => {
    insertGate(db, { id: "g1", gate_type: "deploy", task_id: "3.1", session_id: "s1", requested_at: "2026-04-01T10:00:00Z", context_summary: "test" });
    const res = await post("/api/gates/g1/decide", { decision: "maybe" });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown gate", async () => {
    const res = await post("/api/gates/unknown/decide", { decision: "approved" });
    expect(res.status).toBe(404);
  });
});

// --- Costs ---

describe("GET /api/cost/daily", () => {
  test("returns daily spend", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: null, model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    insertCostEntry(db, { session_id: "s1", service: "anthropic:sonnet", amount_usd: 1.50, logged_at: "2026-04-01T10:00:00Z" });
    const res = await get("/api/cost/daily?date=2026-04-01");
    const body = await res.json();
    expect(body.data.total).toBe(1.50);
    expect(body.data.breakdown).toHaveLength(1);
  });
});

describe("GET /api/cost/session/:id", () => {
  test("returns session cost", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: null, model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    insertCostEntry(db, { session_id: "s1", service: "anthropic:sonnet", amount_usd: 2.00, logged_at: "2026-04-01T10:00:00Z" });
    const res = await get("/api/cost/session/s1");
    const body = await res.json();
    expect(body.data.cost).toBe(2.00);
  });
});

// --- Projects ---

describe("GET /api/projects", () => {
  test("returns empty list when no projects", async () => {
    const res = await get("/api/projects");
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test("returns all projects", async () => {
    insertProject(db, { id: "p1", name: "OpenPaw", description: "Agent fleet", repo_url: null, workspace_path: "/workspaces/openpaw" });
    const res = await get("/api/projects");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("OpenPaw");
  });
});

describe("GET /api/projects/:id", () => {
  test("returns project by id", async () => {
    insertProject(db, { id: "p1", name: "Test", description: null, repo_url: null, workspace_path: null });
    const res = await get("/api/projects/p1");
    const body = await res.json();
    expect(body.data.id).toBe("p1");
  });

  test("returns 404 for unknown project", async () => {
    const res = await get("/api/projects/unknown");
    expect(res.status).toBe(404);
  });
});

// --- Communications ---

describe("GET /api/communications/pending", () => {
  test("returns pending communications", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "twitter",
      recipient: "@user", content_type: "text", content: "Hello world",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await get("/api/communications/pending");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].content).toBe("Hello world");
  });
});

describe("GET /api/communications/:id", () => {
  test("returns communication by id", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "email",
      recipient: "test@x.com", content_type: "text", content: "Test",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await get("/api/communications/c1");
    const body = await res.json();
    expect(body.data.platform).toBe("email");
  });

  test("returns 404 for unknown communication", async () => {
    const res = await get("/api/communications/unknown");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/communications/:id/decide", () => {
  test("approves a communication", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "twitter",
      recipient: "@user", content_type: "text", content: "Post",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await post("/api/communications/c1/decide", { decision: "approved" });
    const body = await res.json();
    expect(body.data.decision).toBe("approved");
  });

  test("approves with edits", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "twitter",
      recipient: "@user", content_type: "text", content: "Original",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await post("/api/communications/c1/decide", {
      decision: "approved_edited",
      edited_content: "Edited version",
    });
    expect(res.status).toBe(200);
  });

  test("returns 400 for invalid decision", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "twitter",
      recipient: "@user", content_type: "text", content: "Post",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await post("/api/communications/c1/decide", { decision: "maybe" });
    expect(res.status).toBe(400);
  });

  test("returns 400 for approved_edited without content", async () => {
    insertPendingCommunication(db, {
      id: "c1", gate_id: null, agent_id: null, platform: "twitter",
      recipient: "@user", content_type: "text", content: "Post",
      metadata: null, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await post("/api/communications/c1/decide", { decision: "approved_edited" });
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown communication", async () => {
    const res = await post("/api/communications/unknown/decide", { decision: "approved" });
    expect(res.status).toBe(404);
  });
});
