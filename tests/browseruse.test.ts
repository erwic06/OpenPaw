import { describe, it, expect } from "bun:test";
import { browseUrl, getBrowserUseToolDeclaration } from "../src/tools/browseruse.ts";
import type { BrowserUseDeps } from "../src/tools/browseruse.ts";

/** Helper to build a mock fetch that returns predetermined responses for sequential calls. */
function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let callIndex = 0;
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const resp = responses[callIndex++];
    if (!resp) throw new Error("Unexpected fetch call");
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeDeps(overrides?: Partial<BrowserUseDeps>): BrowserUseDeps {
  return {
    cloudApiKey: "bu_test_key",
    ...overrides,
  };
}

describe("browseUrl", () => {
  it("returns content from a successful session", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        // POST /sessions — created, already running
        { status: 200, body: { id: "sess-1", status: "running", title: null, output: null, isTaskSuccessful: null, lastStepSummary: null } },
        // GET /sessions/sess-1 — stopped with output
        { status: 200, body: { id: "sess-1", status: "stopped", title: "Page Title", output: "Page content text here", isTaskSuccessful: true, lastStepSummary: "Done" } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Page Title");
    expect(result.content).toBe("Page content text here");
    expect(result.error).toBeUndefined();
  });

  it("returns content when session is immediately stopped", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-2", status: "stopped", title: "Fast Page", output: "Quick result", isTaskSuccessful: true, lastStepSummary: null } },
      ]),
    });

    const result = await browseUrl(deps, "https://fast.com");
    expect(result.content).toBe("Quick result");
    expect(result.error).toBeUndefined();
  });

  it("returns error on API creation failure", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 401, body: { detail: "Invalid API key" } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.error).toContain("401");
    expect(result.content).toBe("");
  });

  it("returns error on poll failure", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-3", status: "running", title: null, output: null, isTaskSuccessful: null, lastStepSummary: null } },
        { status: 500, body: { detail: "Internal error" } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.error).toContain("500");
  });

  it("returns error when session errors out", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-4", status: "error", title: "Error Page", output: null, isTaskSuccessful: false, lastStepSummary: "Navigation failed" } },
      ]),
    });

    const result = await browseUrl(deps, "https://bad-url.invalid");
    expect(result.error).toBe("Navigation failed");
    expect(result.title).toBe("Error Page");
  });

  it("returns error when task is unsuccessful", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-5", status: "stopped", title: "Failed", output: null, isTaskSuccessful: false, lastStepSummary: "Could not complete" } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.error).toBe("Could not complete");
  });

  it("truncates content exceeding maxContentLength", async () => {
    const longContent = "A".repeat(200);
    const deps = makeDeps({
      maxContentLength: 50,
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-6", status: "stopped", title: "Long Page", output: longContent, isTaskSuccessful: true, lastStepSummary: null } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.content.length).toBeLessThan(200);
    expect(result.content).toContain("[Content truncated]");
    // First 50 chars preserved
    expect(result.content.startsWith("A".repeat(50))).toBe(true);
  });

  it("handles structured output (object) from API", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-7", status: "stopped", title: "Structured", output: { key: "value", data: [1, 2, 3] }, isTaskSuccessful: true, lastStepSummary: null } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.content).toContain("key");
    expect(result.content).toContain("value");
  });

  it("handles null output gracefully", async () => {
    const deps = makeDeps({
      fetchFn: mockFetch([
        { status: 200, body: { id: "sess-8", status: "stopped", title: "Empty", output: null, isTaskSuccessful: true, lastStepSummary: null } },
      ]),
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.content).toBe("");
    expect(result.error).toBeUndefined();
  });

  it("handles fetch exceptions gracefully", async () => {
    const deps = makeDeps({
      fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });

    const result = await browseUrl(deps, "https://example.com");
    expect(result.error).toBe("ECONNREFUSED");
    expect(result.content).toBe("");
  });

  it("includes action in the task instruction", async () => {
    let capturedBody = "";
    const deps = makeDeps({
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          capturedBody = init.body as string;
        }
        return new Response(
          JSON.stringify({ id: "sess-9", status: "stopped", title: "Action Page", output: "result", isTaskSuccessful: true, lastStepSummary: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    await browseUrl(deps, "https://example.com/docs", { action: "Click the API tab" });
    const parsed = JSON.parse(capturedBody);
    expect(parsed.task).toContain("Click the API tab");
    expect(parsed.task).toContain("https://example.com/docs");
  });
});

describe("getBrowserUseToolDeclaration", () => {
  it("returns a valid Gemini function declaration", () => {
    const decl = getBrowserUseToolDeclaration();
    expect(decl.name).toBe("browse_url");
    expect(decl.description).toBeTruthy();
    expect(decl.parameters.type).toBe("OBJECT");
    expect(decl.parameters.properties.url).toBeDefined();
    expect(decl.parameters.properties.url.type).toBe("STRING");
    expect(decl.parameters.required).toContain("url");
  });

  it("includes optional action parameter", () => {
    const decl = getBrowserUseToolDeclaration();
    expect(decl.parameters.properties.action).toBeDefined();
    expect(decl.parameters.properties.action.type).toBe("STRING");
    // action should not be required
    expect(decl.parameters.required).not.toContain("action");
  });
});
