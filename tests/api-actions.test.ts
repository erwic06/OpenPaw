import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createRouter } from "../src/api/router.ts";
import { allRoutes } from "../src/api/routes/index.ts";
import { initDatabase, insertSession } from "../src/db/index.ts";
import type { ApiDeps } from "../src/api/types.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-api-actions-" + process.pid);
let db: ReturnType<typeof initDatabase>;
let router: (req: Request) => Response | Promise<Response>;
let planPath: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  planPath = join(TMP_DIR, "plan.md");
  writeFileSync(
    planPath,
    `# Plan

### 3.1 -- Agent Types
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`src/types.ts\`
- **Acceptance:** Types exported

#### Notes
#### Failure History

---
`,
  );

  const deps: ApiDeps = {
    db,
    planPath,
    resolveGateFn: async () => ({ success: true }),
  };
  router = createRouter(allRoutes(), deps);
});

function post(path: string, body: unknown): Promise<Response> {
  return router(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function get(path: string): Promise<Response> {
  return router(new Request(`http://localhost${path}`));
}

describe("GET /api/tasks/:id", () => {
  test("returns task from plan", async () => {
    const res = await get("/api/tasks/3.1");
    const body = await res.json();
    expect(body.data.id).toBe("3.1");
    expect(body.data.title).toBe("Agent Types");
    expect(body.data.status).toBe("complete");
  });

  test("returns 404 for unknown task", async () => {
    const res = await get("/api/tasks/99.9");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tasks/:id/sessions", () => {
  test("returns sessions for task", async () => {
    insertSession(db, { id: "s1", agent: "coder", task_id: "3.1", model: "sonnet", provider: "anthropic", started_at: "2026-04-01T10:00:00Z" });
    insertSession(db, { id: "s2", agent: "coder", task_id: "3.2", model: "sonnet", provider: "anthropic", started_at: "2026-04-01T11:00:00Z" });
    const res = await get("/api/tasks/3.1/sessions");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("s1");
  });
});

describe("POST /api/tasks", () => {
  test("returns 400 for missing type", async () => {
    const res = await post("/api/tasks", { prompt: "do stuff" });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid type", async () => {
    const res = await post("/api/tasks", { type: "deploy", prompt: "do stuff" });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing prompt", async () => {
    const res = await post("/api/tasks", { type: "research" });
    expect(res.status).toBe(400);
  });

  test("returns 400 for research with invalid depth", async () => {
    const res = await post("/api/tasks", { type: "research", prompt: "test", depth: 15 });
    expect(res.status).toBe(400);
  });

  test("returns 501 for research when not wired", async () => {
    const res = await post("/api/tasks", { type: "research", prompt: "test" });
    expect(res.status).toBe(501);
  });

  test("returns 400 for coding without projectName", async () => {
    const res = await post("/api/tasks", { type: "coding", prompt: "add feature" });
    expect(res.status).toBe(400);
  });

  test("returns 501 for coding when not wired", async () => {
    const res = await post("/api/tasks", { type: "coding", prompt: "add feature", projectName: "myproject" });
    expect(res.status).toBe(501);
  });

  test("calls createResearchTask when wired", async () => {
    let called = false;
    const deps: ApiDeps = {
      db,
      planPath,
      createResearchTask: async ({ prompt, depth }) => {
        called = true;
        expect(prompt).toBe("test query");
        expect(depth).toBe(7);
        return "task-123";
      },
    };
    const r = createRouter(allRoutes(), deps);
    const res = await r(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify({ type: "research", prompt: "test query", depth: 7 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await res.json();
    expect(called).toBe(true);
    expect(body.data.taskId).toBe("task-123");
    expect(body.data.status).toBe("accepted");
  });
});

describe("POST /api/projects", () => {
  test("returns 400 for missing name", async () => {
    const res = await post("/api/projects", { description: "a project" });
    expect(res.status).toBe(400);
  });

  test("returns 501 when not wired", async () => {
    const res = await post("/api/projects", { name: "MyProject", description: "desc" });
    expect(res.status).toBe(501);
  });

  test("calls createProject when wired", async () => {
    let called = false;
    const deps: ApiDeps = {
      db,
      planPath,
      createProject: async ({ name, description }) => {
        called = true;
        expect(name).toBe("MyProject");
        return "proj-abc";
      },
    };
    const r = createRouter(allRoutes(), deps);
    const res = await r(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "MyProject", description: "desc" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await res.json();
    expect(called).toBe(true);
    expect(body.data.projectId).toBe("proj-abc");
  });
});
