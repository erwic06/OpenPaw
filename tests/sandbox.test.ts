import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mock the @daytonaio/sdk module ---

const mockDelete = mock(() => Promise.resolve());
const mockGitClone = mock(() => Promise.resolve());
let sandboxIdCounter = 0;

const mockCreate = mock(() => {
  sandboxIdCounter++;
  return Promise.resolve({
    id: `sb-${sandboxIdCounter}`,
    name: `sandbox-${sandboxIdCounter}`,
    fs: { readFile: mock(), writeFile: mock() },
    git: { clone: mockGitClone },
    process: { executeCommand: mock() },
    state: "started",
  });
});

mock.module("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {
    constructor(_config?: any) {}
    create = mockCreate;
    delete = mockDelete;
  },
  CodeLanguage: { TYPESCRIPT: "typescript" },
}));

// Import after mock is set up
const {
  createSandbox,
  getSandbox,
  destroySandbox,
  _resetForTesting,
} = await import("../src/sandbox/index.ts");

import type { SandboxDeps, SandboxConfig } from "../src/sandbox/types.ts";

const TEST_DEPS: SandboxDeps = {
  apiKey: "test-api-key",
  apiUrl: "https://test.daytona.io/api",
};

function makeConfig(sessionId: string): SandboxConfig {
  return {
    sessionId,
    repoUrl: "https://github.com/user/repo.git",
    branch: "main",
  };
}

beforeEach(() => {
  _resetForTesting();
  mockCreate.mockClear();
  mockDelete.mockClear();
  mockGitClone.mockClear();
  sandboxIdCounter = 0;
});

describe("createSandbox", () => {
  it("creates a sandbox and returns a handle", async () => {
    const handle = await createSandbox(TEST_DEPS, makeConfig("s1"));
    expect(handle.sessionId).toBe("s1");
    expect(handle.sandboxId).toBe("sb-1");
    expect(handle.sandbox).toBeDefined();
    expect(handle.sandbox.fs).toBeDefined();
    expect(handle.sandbox.git).toBeDefined();
    expect(handle.sandbox.process).toBeDefined();
  });

  it("calls Daytona.create with typescript language and session label", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.language).toBe("typescript");
    expect(params.labels).toEqual({ sessionId: "s1" });
    expect(params.autoStopInterval).toBe(0);
    expect(options.timeout).toBe(120);
  });

  it("clones repo into workspace after creation", async () => {
    const config = makeConfig("s1");
    await createSandbox(TEST_DEPS, config);
    expect(mockGitClone).toHaveBeenCalledTimes(1);
    expect(mockGitClone).toHaveBeenCalledWith(
      config.repoUrl,
      "/home/daytona",
      config.branch,
    );
  });

  it("throws if sandbox already exists for session", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    expect(createSandbox(TEST_DEPS, makeConfig("s1"))).rejects.toThrow(
      "Sandbox already exists for session: s1",
    );
  });

  it("allows creating sandboxes for different sessions", async () => {
    const h1 = await createSandbox(TEST_DEPS, makeConfig("s1"));
    const h2 = await createSandbox(TEST_DEPS, makeConfig("s2"));
    expect(h1.sandboxId).toBe("sb-1");
    expect(h2.sandboxId).toBe("sb-2");
  });
});

describe("getSandbox", () => {
  it("returns the handle for an active session", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    const handle = getSandbox("s1");
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("s1");
    expect(handle!.sandboxId).toBe("sb-1");
  });

  it("returns undefined for unknown session", () => {
    expect(getSandbox("nonexistent")).toBeUndefined();
  });

  it("returns undefined after sandbox is destroyed", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    await destroySandbox(TEST_DEPS, "s1");
    expect(getSandbox("s1")).toBeUndefined();
  });
});

describe("destroySandbox", () => {
  it("calls Daytona.delete and removes from map", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    await destroySandbox(TEST_DEPS, "s1");
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(getSandbox("s1")).toBeUndefined();
  });

  it("is a no-op for unknown session", async () => {
    await destroySandbox(TEST_DEPS, "nonexistent");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("allows re-creating sandbox after destroy", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    await destroySandbox(TEST_DEPS, "s1");
    const handle = await createSandbox(TEST_DEPS, makeConfig("s1"));
    expect(handle.sandboxId).toBe("sb-2");
    expect(getSandbox("s1")).toBeDefined();
  });

  it("only destroys the specified session", async () => {
    await createSandbox(TEST_DEPS, makeConfig("s1"));
    await createSandbox(TEST_DEPS, makeConfig("s2"));
    await destroySandbox(TEST_DEPS, "s1");
    expect(getSandbox("s1")).toBeUndefined();
    expect(getSandbox("s2")).toBeDefined();
  });
});
