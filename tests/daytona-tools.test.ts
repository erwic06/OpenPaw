import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { Sandbox } from "@daytonaio/sdk";
import { validatePath } from "../src/agents/tools/index.ts";
import {
  createFileReadTool,
  createFileWriteTool,
  createFileListTool,
  createShellExecTool,
  createGitStatusTool,
  createGitAddTool,
  createGitCommitTool,
  createGitPushTool,
  createGitDiffTool,
  createGitCreateBranchTool,
  createGitCheckoutTool,
} from "../src/agents/tools/daytona-tools.ts";
import { createDaytonaToolServer } from "../src/agents/tools/index.ts";

function mockSandbox(): Sandbox {
  return {
    fs: {
      downloadFile: mock((path: string) =>
        Promise.resolve(Buffer.from(`content of ${path}`, "utf-8")),
      ),
      uploadFile: mock(() => Promise.resolve()),
      listFiles: mock(() =>
        Promise.resolve([
          { name: "file1.ts" },
          { name: "file2.ts" },
          { name: "src" },
        ]),
      ),
    },
    process: {
      executeCommand: mock((cmd: string, _cwd?: string) =>
        Promise.resolve({ exitCode: 0, result: `output of: ${cmd}` }),
      ),
    },
    git: {
      status: mock(() =>
        Promise.resolve({
          currentBranch: "main",
          ahead: 0,
          behind: 0,
          branchPublished: true,
          fileStatus: [],
        }),
      ),
      add: mock(() => Promise.resolve()),
      commit: mock(() => Promise.resolve({ sha: "abc1234" })),
      push: mock(() => Promise.resolve()),
      createBranch: mock(() => Promise.resolve()),
      checkoutBranch: mock(() => Promise.resolve()),
      clone: mock(() => Promise.resolve()),
    },
  } as unknown as Sandbox;
}

/** Helper to call the tool handler directly (bypasses MCP layer). */
async function callTool(toolDef: any, args: Record<string, unknown>) {
  return toolDef.handler(args, {});
}

describe("validatePath", () => {
  it("accepts paths within /workspace/", () => {
    expect(() => validatePath("/workspace/src/index.ts")).not.toThrow();
    expect(() => validatePath("/workspace/")).not.toThrow();
    expect(() => validatePath("/workspace")).not.toThrow();
  });

  it("rejects paths outside /workspace/", () => {
    expect(() => validatePath("/etc/passwd")).toThrow("must be within /workspace/");
    expect(() => validatePath("/home/user/file")).toThrow("must be within /workspace/");
    expect(() => validatePath("/")).toThrow("must be within /workspace/");
  });

  it("rejects directory traversal", () => {
    expect(() => validatePath("/workspace/../etc/passwd")).toThrow(
      "Directory traversal not allowed",
    );
    expect(() => validatePath("/workspace/src/../../etc")).toThrow(
      "Directory traversal not allowed",
    );
  });

  it("handles double slashes and trailing slashes", () => {
    expect(() => validatePath("/workspace//src//file.ts")).not.toThrow();
    expect(() => validatePath("/workspace/src/")).not.toThrow();
  });
});

describe("file_read", () => {
  it("reads file content from sandbox", async () => {
    const sb = mockSandbox();
    const tool = createFileReadTool(sb);
    const result = await callTool(tool, { path: "/workspace/src/index.ts" });
    expect(result.content[0].text).toBe("content of /workspace/src/index.ts");
    expect(sb.fs.downloadFile).toHaveBeenCalledWith("/workspace/src/index.ts");
  });

  it("rejects paths outside workspace", async () => {
    const sb = mockSandbox();
    const tool = createFileReadTool(sb);
    expect(callTool(tool, { path: "/etc/passwd" })).rejects.toThrow(
      "must be within /workspace/",
    );
  });
});

describe("file_write", () => {
  it("writes content to sandbox file", async () => {
    const sb = mockSandbox();
    const tool = createFileWriteTool(sb);
    const result = await callTool(tool, {
      path: "/workspace/out.txt",
      content: "hello world",
    });
    expect(result.content[0].text).toContain("Wrote 11 bytes");
    expect(sb.fs.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("rejects paths outside workspace", async () => {
    const sb = mockSandbox();
    const tool = createFileWriteTool(sb);
    expect(
      callTool(tool, { path: "/tmp/evil.sh", content: "rm -rf /" }),
    ).rejects.toThrow("must be within /workspace/");
  });
});

describe("file_list", () => {
  it("lists directory contents", async () => {
    const sb = mockSandbox();
    const tool = createFileListTool(sb);
    const result = await callTool(tool, { path: "/workspace" });
    expect(result.content[0].text).toContain("file1.ts");
    expect(result.content[0].text).toContain("file2.ts");
    expect(result.content[0].text).toContain("src");
  });
});

describe("shell_exec", () => {
  it("executes command and returns output", async () => {
    const sb = mockSandbox();
    const tool = createShellExecTool(sb);
    const result = await callTool(tool, { command: "ls -la" });
    expect(result.content[0].text).toContain("exit_code: 0");
    expect(result.content[0].text).toContain("output of: ls -la");
  });

  it("uses /workspace as default cwd", async () => {
    const sb = mockSandbox();
    const tool = createShellExecTool(sb);
    await callTool(tool, { command: "pwd" });
    expect(sb.process.executeCommand).toHaveBeenCalledWith("pwd", "/workspace");
  });

  it("validates custom cwd", async () => {
    const sb = mockSandbox();
    const tool = createShellExecTool(sb);
    expect(
      callTool(tool, { command: "ls", cwd: "/tmp" }),
    ).rejects.toThrow("must be within /workspace/");
  });
});

describe("git_status", () => {
  it("returns repository status as JSON", async () => {
    const sb = mockSandbox();
    const tool = createGitStatusTool(sb);
    const result = await callTool(tool, {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.currentBranch).toBe("main");
    expect(sb.git.status).toHaveBeenCalledWith("/workspace");
  });
});

describe("git_add", () => {
  it("stages files", async () => {
    const sb = mockSandbox();
    const tool = createGitAddTool(sb);
    const result = await callTool(tool, { files: ["file1.ts", "file2.ts"] });
    expect(result.content[0].text).toContain("Staged 2 file(s)");
    expect(sb.git.add).toHaveBeenCalledWith("/workspace", [
      "file1.ts",
      "file2.ts",
    ]);
  });
});

describe("git_commit", () => {
  it("creates a commit and returns SHA", async () => {
    const sb = mockSandbox();
    const tool = createGitCommitTool(sb);
    const result = await callTool(tool, {
      message: "test commit",
      author: "Test User",
      email: "test@example.com",
    });
    expect(result.content[0].text).toContain("abc1234");
    expect(sb.git.commit).toHaveBeenCalledWith(
      "/workspace",
      "test commit",
      "Test User",
      "test@example.com",
    );
  });
});

describe("git_push", () => {
  it("pushes to remote", async () => {
    const sb = mockSandbox();
    const tool = createGitPushTool(sb);
    const result = await callTool(tool, {});
    expect(result.content[0].text).toBe("Pushed to remote");
    expect(sb.git.push).toHaveBeenCalledWith("/workspace");
  });
});

describe("git_diff", () => {
  it("runs git diff via process.executeCommand", async () => {
    const sb = mockSandbox();
    const tool = createGitDiffTool(sb);
    const result = await callTool(tool, {});
    expect(result.content[0].text).toContain("output of: git diff");
    expect(sb.process.executeCommand).toHaveBeenCalledWith(
      "git diff",
      "/workspace",
    );
  });

  it("passes additional args", async () => {
    const sb = mockSandbox();
    const tool = createGitDiffTool(sb);
    await callTool(tool, { args: "--cached" });
    expect(sb.process.executeCommand).toHaveBeenCalledWith(
      "git diff --cached",
      "/workspace",
    );
  });
});

describe("git_create_branch", () => {
  it("creates a new branch", async () => {
    const sb = mockSandbox();
    const tool = createGitCreateBranchTool(sb);
    const result = await callTool(tool, { name: "feature/test" });
    expect(result.content[0].text).toContain("feature/test");
    expect(sb.git.createBranch).toHaveBeenCalledWith(
      "/workspace",
      "feature/test",
    );
  });
});

describe("git_checkout", () => {
  it("switches to a branch", async () => {
    const sb = mockSandbox();
    const tool = createGitCheckoutTool(sb);
    const result = await callTool(tool, { branch: "develop" });
    expect(result.content[0].text).toContain("develop");
    expect(sb.git.checkoutBranch).toHaveBeenCalledWith("/workspace", "develop");
  });
});

describe("createDaytonaToolServer", () => {
  it("returns a valid MCP server config", () => {
    const sb = mockSandbox();
    const server = createDaytonaToolServer(sb);
    expect(server).toBeDefined();
    // The server config should have the expected shape for query() mcpServers
    expect(typeof server).toBe("object");
  });
});
