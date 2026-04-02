import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { ServiceAdapter, ServiceAdapterError } from "../src/agents/service-adapter.ts";
import type { ServiceAdapterConfig, ServiceAdapterDeps } from "../src/agents/service-adapter.ts";
import type { AgentInput } from "../src/agents/types.ts";

const SCHEMA_PATH = import.meta.dir + "/../src/db/schema.sql";

function freshDb(): Database {
  const db = new Database(":memory:");
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

const BASE_CONFIG: ServiceAdapterConfig = {
  baseUrl: "http://localhost:8100",
  auth: "test-token",
  healthCheck: "/health",
  triggerEndpoint: "/trigger",
  statusEndpoint: "/status/{session_id}",
  outputEndpoint: "/output/{session_id}",
};

const SAMPLE_INPUT: AgentInput = {
  taskId: "T1",
  taskTitle: "Test Task",
  contractPath: "/tmp/contract.md",
  systemPromptPath: null,
  modelTier: "standard",
  tools: ["file_write"],
  budgetUsd: 1.0,
};

function mockFetch(status: number, body: unknown): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { "Content-Type": "application/json" },
    });
  };
}

let db: Database;

beforeEach(() => {
  db = freshDb();
});

describe("ServiceAdapter", () => {
  describe("trigger", () => {
    test("sends POST and returns session ID", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      const fetchFn: typeof fetch = async (url, init) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return new Response("{}", { status: 200 });
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      const sessionId = await adapter.trigger(SAMPLE_INPUT);

      expect(sessionId).toMatch(/^service-/);
      expect(capturedUrl).toBe("http://localhost:8100/trigger");
      const body = JSON.parse(capturedBody);
      expect(body.taskId).toBe("T1");
      expect(body.sessionId).toBe(sessionId);
    });

    test("inserts session row in DB", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(200, {}),
      });
      const sessionId = await adapter.trigger(SAMPLE_INPUT);

      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.agent).toBe("service");
      expect(row.task_id).toBe("T1");
    });

    test("throws retryable error on 5xx", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(503, { error: "overloaded" }),
      });

      try {
        await adapter.trigger(SAMPLE_INPUT);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceAdapterError);
        expect((err as ServiceAdapterError).retryable).toBe(true);
        expect((err as ServiceAdapterError).message).toContain("503");
      }
    });

    test("throws non-retryable error on 4xx", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(400, { error: "bad request" }),
      });

      try {
        await adapter.trigger(SAMPLE_INPUT);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceAdapterError);
        expect((err as ServiceAdapterError).retryable).toBe(false);
      }
    });
  });

  describe("status", () => {
    test("polls status endpoint with session ID substitution", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (url) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      const result = await adapter.status("session-abc");

      expect(capturedUrl).toBe("http://localhost:8100/status/session-abc");
      expect(result).toBe("running");
    });

    test("maps various status strings", async () => {
      for (const [input, expected] of [
        ["complete", "complete"],
        ["completed", "complete"],
        ["success", "complete"],
        ["failed", "failed"],
        ["error", "failed"],
        ["running", "running"],
        ["pending", "running"],
        ["in_progress", "running"],
        ["waiting_hitl", "waiting_hitl"],
        ["unknown_status", "running"],
      ] as const) {
        const adapter = new ServiceAdapter({
          db,
          config: BASE_CONFIG,
          fetchFn: mockFetch(200, { status: input }),
        });
        const result = await adapter.status("s1");
        expect(result).toBe(expected);
      }
    });

    test("throws on 5xx", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(500, {}),
      });

      try {
        await adapter.status("s1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceAdapterError);
        expect((err as ServiceAdapterError).retryable).toBe(true);
      }
    });
  });

  describe("output", () => {
    test("retrieves output from output endpoint", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (url) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(
          JSON.stringify({ artifacts: ["file.txt"], costUsd: 0.5 }),
          { status: 200 },
        );
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      const result = await adapter.output("session-xyz");

      expect(capturedUrl).toBe("http://localhost:8100/output/session-xyz");
      expect(result.sessionId).toBe("session-xyz");
      expect(result.artifacts).toEqual(["file.txt"]);
      expect(result.costUsd).toBe(0.5);
      expect(result.terminalState).toBe("complete");
      expect(result.error).toBeNull();
    });

    test("returns failed state when error present", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(200, { error: "something went wrong" }),
      });
      const result = await adapter.output("s1");
      expect(result.terminalState).toBe("failed");
      expect(result.error).toBe("something went wrong");
    });

    test("defaults missing fields", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(200, {}),
      });
      const result = await adapter.output("s1");
      expect(result.artifacts).toEqual([]);
      expect(result.costUsd).toBe(0);
      expect(result.error).toBeNull();
    });
  });

  describe("cancel", () => {
    test("sends DELETE and updates DB", async () => {
      let capturedMethod = "";
      const fetchFn: typeof fetch = async (_url, init) => {
        capturedMethod = init?.method ?? "";
        return new Response("{}", { status: 200 });
      };

      // Insert session first
      db.prepare(
        "INSERT INTO sessions (id, agent, task_id, model, provider, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s1", "service", "T1", "external", "anthropic", new Date().toISOString());

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      await adapter.cancel("s1");

      expect(capturedMethod).toBe("DELETE");
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get("s1") as Record<string, unknown>;
      expect(row.terminal_state).toBe("failed");
      expect(row.error).toBe("Cancelled by user");
    });

    test("tolerates 404 on cancel", async () => {
      db.prepare(
        "INSERT INTO sessions (id, agent, task_id, model, provider, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s1", "service", "T1", "external", "anthropic", new Date().toISOString());

      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(404, {}),
      });

      // Should not throw
      await adapter.cancel("s1");
    });
  });

  describe("healthCheck", () => {
    test("returns true on 200", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (url) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response("{}", { status: 200 });
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      const result = await adapter.healthCheck();

      expect(result).toBe(true);
      expect(capturedUrl).toBe("http://localhost:8100/health");
    });

    test("returns false on non-200", async () => {
      const adapter = new ServiceAdapter({
        db,
        config: BASE_CONFIG,
        fetchFn: mockFetch(503, {}),
      });
      expect(await adapter.healthCheck()).toBe(false);
    });

    test("returns false on network error", async () => {
      const fetchFn: typeof fetch = async () => {
        throw new Error("connection refused");
      };
      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  describe("auth", () => {
    test("resolves secret from secrets map", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          new Headers(init?.headers as HeadersInit).entries(),
        );
        return new Response("{}", { status: 200 });
      };

      const config = { ...BASE_CONFIG, auth: "bearer ${MY_SECRET}" };
      const secrets = new Map([["MY_SECRET", "resolved-token"]]);
      const adapter = new ServiceAdapter({ db, config, fetchFn, secrets });

      await adapter.healthCheck();
      expect(capturedHeaders["authorization"]).toBe("bearer resolved-token");
    });

    test("uses auth string directly when no ${} pattern", async () => {
      let capturedHeaders: Record<string, string> = {};
      const fetchFn: typeof fetch = async (_url, init) => {
        capturedHeaders = Object.fromEntries(
          new Headers(init?.headers as HeadersInit).entries(),
        );
        return new Response("{}", { status: 200 });
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });
      await adapter.healthCheck();
      expect(capturedHeaders["authorization"]).toBe("Bearer test-token");
    });

    test("throws when secret not found", async () => {
      const config = { ...BASE_CONFIG, auth: "bearer ${MISSING_SECRET}" };
      const secrets = new Map<string, string>();
      const adapter = new ServiceAdapter({ db, config, fetchFn: mockFetch(200, { status: "running" }), secrets });

      try {
        await adapter.status("s1");
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("MISSING_SECRET");
      }
    });
  });

  describe("endpoint resolution", () => {
    test("appends session ID when no template placeholder", async () => {
      let capturedUrl = "";
      const fetchFn: typeof fetch = async (url) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      };

      const config = { ...BASE_CONFIG, statusEndpoint: "/api/status" };
      const adapter = new ServiceAdapter({ db, config, fetchFn });
      await adapter.status("s1");

      expect(capturedUrl).toBe("http://localhost:8100/api/status/s1");
    });
  });

  describe("timeout / network errors", () => {
    test("wraps fetch errors as retryable ServiceAdapterError", async () => {
      const fetchFn: typeof fetch = async () => {
        throw new Error("connection refused");
      };

      const adapter = new ServiceAdapter({ db, config: BASE_CONFIG, fetchFn });

      try {
        await adapter.status("s1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceAdapterError);
        expect((err as ServiceAdapterError).retryable).toBe(true);
        expect((err as ServiceAdapterError).message).toContain("connection refused");
      }
    });
  });
});
