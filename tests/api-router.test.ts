import { describe, test, expect } from "bun:test";
import { createRouter, jsonResponse, errorResponse } from "../src/api/router.ts";
import type { Route, ApiDeps } from "../src/api/types.ts";

function makeDeps(): ApiDeps {
  return { db: null as any };
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, init);
}

describe("jsonResponse", () => {
  test("returns JSON with default 200 status", async () => {
    const res = jsonResponse({ data: "hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ data: "hello" });
  });

  test("returns JSON with custom status", async () => {
    const res = jsonResponse({ ok: true }, 201);
    expect(res.status).toBe(201);
  });
});

describe("errorResponse", () => {
  test("returns error JSON with status", async () => {
    const res = errorResponse("Not found", 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Not found" });
  });
});

describe("createRouter", () => {
  test("matches exact path", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/health",
        handler: () => new Response("ok"),
      },
    ];
    const router = createRouter(routes, makeDeps());
    const res = await router(makeRequest("GET", "/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("extracts URL params", async () => {
    let captured: Record<string, string> = {};
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/sessions/:id",
        handler: (ctx) => {
          captured = ctx.params;
          return jsonResponse({ id: ctx.params.id });
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("GET", "/api/sessions/abc-123"));
    expect(captured.id).toBe("abc-123");
  });

  test("extracts multiple URL params", async () => {
    let captured: Record<string, string> = {};
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/projects/:pid/tasks/:tid",
        handler: (ctx) => {
          captured = ctx.params;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("GET", "/api/projects/p1/tasks/t2"));
    expect(captured.pid).toBe("p1");
    expect(captured.tid).toBe("t2");
  });

  test("dispatches by method", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/items",
        handler: () => jsonResponse({ action: "list" }),
      },
      {
        method: "POST",
        pattern: "/api/items",
        handler: () => jsonResponse({ action: "create" }, 201),
      },
    ];
    const router = createRouter(routes, makeDeps());

    const getRes = await router(makeRequest("GET", "/api/items"));
    expect((await getRes.json()).action).toBe("list");

    const postRes = await router(makeRequest("POST", "/api/items", { name: "test" }));
    expect(postRes.status).toBe(201);
    expect((await postRes.json()).action).toBe("create");
  });

  test("parses JSON body for POST", async () => {
    let captured: unknown = null;
    const routes: Route[] = [
      {
        method: "POST",
        pattern: "/api/data",
        handler: (ctx) => {
          captured = ctx.body;
          return jsonResponse({ ok: true });
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("POST", "/api/data", { foo: "bar" }));
    expect(captured).toEqual({ foo: "bar" });
  });

  test("body is null for GET requests", async () => {
    let captured: unknown = "not-null";
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/data",
        handler: (ctx) => {
          captured = ctx.body;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("GET", "/api/data"));
    expect(captured).toBeNull();
  });

  test("returns 404 for unmatched path", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/sessions",
        handler: () => jsonResponse([]),
      },
    ];
    const router = createRouter(routes, makeDeps());
    const res = await router(makeRequest("GET", "/api/unknown"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("returns 405 for wrong method on matched path", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/sessions",
        handler: () => jsonResponse([]),
      },
    ];
    const router = createRouter(routes, makeDeps());
    const res = await router(makeRequest("DELETE", "/api/sessions"));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  test("handles OPTIONS preflight", async () => {
    const routes: Route[] = [];
    const router = createRouter(routes, makeDeps());
    const res = await router(makeRequest("OPTIONS", "/api/sessions"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("handler error returns 500", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/crash",
        handler: () => {
          throw new Error("boom");
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    const res = await router(makeRequest("GET", "/api/crash"));
    expect(res.status).toBe(500);
  });

  test("provides deps in context", async () => {
    let captured: ApiDeps | null = null;
    const deps = makeDeps();
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/test",
        handler: (ctx) => {
          captured = ctx.deps;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, deps);
    await router(makeRequest("GET", "/api/test"));
    expect(captured).toBe(deps);
  });

  test("provides query params in context", async () => {
    let captured: URLSearchParams | null = null;
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/search",
        handler: (ctx) => {
          captured = ctx.query;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("GET", "/api/search?q=hello&limit=10"));
    expect(captured?.get("q")).toBe("hello");
    expect(captured?.get("limit")).toBe("10");
  });

  test("decodes URL-encoded params", async () => {
    let captured: Record<string, string> = {};
    const routes: Route[] = [
      {
        method: "GET",
        pattern: "/api/items/:id",
        handler: (ctx) => {
          captured = ctx.params;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    await router(makeRequest("GET", "/api/items/hello%20world"));
    expect(captured.id).toBe("hello world");
  });

  test("invalid JSON body sets body to null", async () => {
    let captured: unknown = "not-null";
    const routes: Route[] = [
      {
        method: "POST",
        pattern: "/api/data",
        handler: (ctx) => {
          captured = ctx.body;
          return jsonResponse({});
        },
      },
    ];
    const router = createRouter(routes, makeDeps());
    const req = new Request("http://localhost/api/data", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "text/plain" },
    });
    await router(req);
    expect(captured).toBeNull();
  });
});
