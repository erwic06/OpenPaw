import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSandbox,
  getSandbox,
  destroySandbox,
  _resetForTesting,
} from "../src/sandbox/index.ts";

import type { SandboxDeps, SandboxConfig } from "../src/sandbox/types.ts";

let testBaseDir: string;
let testRepoDir: string;

function makeDeps(): SandboxDeps {
  return { baseDir: testBaseDir };
}

function makeConfig(sessionId: string): SandboxConfig {
  return {
    sessionId,
    repoMount: testRepoDir,
    branch: "main",
  };
}

beforeEach(() => {
  _resetForTesting();

  // Create a temp base directory for workspaces
  testBaseDir = join(tmpdir(), `openpaw-test-workspaces-${Date.now()}`);
  mkdirSync(testBaseDir, { recursive: true });

  // Create a real git repo as the "source" to clone from
  testRepoDir = join(tmpdir(), `openpaw-test-repo-${Date.now()}`);
  mkdirSync(testRepoDir, { recursive: true });

  Bun.spawnSync(["git", "init", "--initial-branch", "main", testRepoDir]);
  Bun.spawnSync(["git", "-C", testRepoDir, "config", "user.email", "test@test.com"]);
  Bun.spawnSync(["git", "-C", testRepoDir, "config", "user.name", "Test"]);
  writeFileSync(join(testRepoDir, "README.md"), "# Test Repo\n");
  Bun.spawnSync(["git", "-C", testRepoDir, "add", "."]);
  Bun.spawnSync(["git", "-C", testRepoDir, "commit", "-m", "initial"]);
});

afterEach(() => {
  _resetForTesting();
  rmSync(testBaseDir, { recursive: true, force: true });
  rmSync(testRepoDir, { recursive: true, force: true });
});

describe("createSandbox", () => {
  it("creates a workspace directory with cloned repo", async () => {
    const handle = await createSandbox(makeDeps(), makeConfig("s1"));
    expect(handle.sessionId).toBe("s1");
    expect(handle.workDir).toBe(join(testBaseDir, "s1"));
    expect(existsSync(join(handle.workDir, "README.md"))).toBe(true);
    expect(existsSync(join(handle.workDir, ".git"))).toBe(true);
  });

  it("throws if sandbox already exists for session", async () => {
    await createSandbox(makeDeps(), makeConfig("s1"));
    expect(createSandbox(makeDeps(), makeConfig("s1"))).rejects.toThrow(
      "Sandbox already exists for session: s1",
    );
  });

  it("allows creating sandboxes for different sessions", async () => {
    const h1 = await createSandbox(makeDeps(), makeConfig("s1"));
    const h2 = await createSandbox(makeDeps(), makeConfig("s2"));
    expect(h1.workDir).not.toBe(h2.workDir);
    expect(existsSync(h1.workDir)).toBe(true);
    expect(existsSync(h2.workDir)).toBe(true);
  });

  it("clones the correct branch", async () => {
    // Create a second branch in the source repo
    Bun.spawnSync(["git", "-C", testRepoDir, "checkout", "-b", "dev"]);
    writeFileSync(join(testRepoDir, "dev-file.txt"), "dev content\n");
    Bun.spawnSync(["git", "-C", testRepoDir, "add", "."]);
    Bun.spawnSync(["git", "-C", testRepoDir, "commit", "-m", "dev commit"]);
    Bun.spawnSync(["git", "-C", testRepoDir, "checkout", "main"]);

    const config = makeConfig("s1");
    config.branch = "dev";
    const handle = await createSandbox(makeDeps(), config);
    expect(existsSync(join(handle.workDir, "dev-file.txt"))).toBe(true);
  });

  it("cleans up orphan directory from a previous crash", async () => {
    // Simulate a crash: workDir exists on disk but not in the in-memory map
    const workDir = join(testBaseDir, "s1");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "stale-file.txt"), "leftover");

    const handle = await createSandbox(makeDeps(), makeConfig("s1"));
    expect(existsSync(join(handle.workDir, "README.md"))).toBe(true);
    expect(existsSync(join(handle.workDir, "stale-file.txt"))).toBe(false);
  });

  it("throws on clone failure and cleans up", async () => {
    const config = makeConfig("s1");
    config.branch = "nonexistent-branch";
    expect(createSandbox(makeDeps(), config)).rejects.toThrow(
      "git clone failed",
    );
    // Workspace should be cleaned up
    expect(existsSync(join(testBaseDir, "s1"))).toBe(false);
  });
});

describe("getSandbox", () => {
  it("returns the handle for an active session", async () => {
    await createSandbox(makeDeps(), makeConfig("s1"));
    const handle = getSandbox("s1");
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("s1");
  });

  it("returns undefined for unknown session", () => {
    expect(getSandbox("nonexistent")).toBeUndefined();
  });

  it("returns undefined after sandbox is destroyed", async () => {
    await createSandbox(makeDeps(), makeConfig("s1"));
    await destroySandbox("s1");
    expect(getSandbox("s1")).toBeUndefined();
  });
});

describe("destroySandbox", () => {
  it("removes directory and clears from map", async () => {
    const handle = await createSandbox(makeDeps(), makeConfig("s1"));
    await destroySandbox("s1");
    expect(existsSync(handle.workDir)).toBe(false);
    expect(getSandbox("s1")).toBeUndefined();
  });

  it("is a no-op for unknown session", async () => {
    await destroySandbox("nonexistent");
    // No throw
  });

  it("allows re-creating sandbox after destroy", async () => {
    await createSandbox(makeDeps(), makeConfig("s1"));
    await destroySandbox("s1");
    const handle = await createSandbox(makeDeps(), makeConfig("s1"));
    expect(handle.sessionId).toBe("s1");
    expect(existsSync(handle.workDir)).toBe(true);
  });

  it("only destroys the specified session", async () => {
    const h1 = await createSandbox(makeDeps(), makeConfig("s1"));
    const h2 = await createSandbox(makeDeps(), makeConfig("s2"));
    await destroySandbox("s1");
    expect(existsSync(h1.workDir)).toBe(false);
    expect(existsSync(h2.workDir)).toBe(true);
    expect(getSandbox("s2")).toBeDefined();
  });
});
