import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Sandbox } from "@daytonaio/sdk";

const WORKSPACE_PREFIX = "/workspace";

/**
 * Validate that a file path is within the allowed workspace.
 * Rejects directory traversal and paths outside /workspace/.
 */
export function validatePath(path: string): void {
  const normalized = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (
    normalized !== WORKSPACE_PREFIX &&
    !normalized.startsWith(WORKSPACE_PREFIX + "/")
  ) {
    throw new Error(
      `Path must be within ${WORKSPACE_PREFIX}/: ${path}`,
    );
  }
  // Check for traversal after prefix
  const afterPrefix = normalized.slice(WORKSPACE_PREFIX.length);
  const segments = afterPrefix.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "..") depth--;
    else if (seg !== "" && seg !== ".") depth++;
    if (depth < 0) {
      throw new Error(`Directory traversal not allowed: ${path}`);
    }
  }
}

// --- File tools ---

export function createFileReadTool(sandbox: Sandbox) {
  return tool(
    "file_read",
    "Read a file from the project workspace",
    { path: z.string().describe("Absolute path within /workspace/") },
    async ({ path }) => {
      validatePath(path);
      const content = await sandbox.fs.downloadFile(path);
      return { content: [{ type: "text" as const, text: content.toString("utf-8") }] };
    },
    { annotations: { readOnlyHint: true } },
  );
}

export function createFileWriteTool(sandbox: Sandbox) {
  return tool(
    "file_write",
    "Write content to a file in the project workspace",
    {
      path: z.string().describe("Absolute path within /workspace/"),
      content: z.string().describe("File content to write"),
    },
    async ({ path, content }) => {
      validatePath(path);
      await sandbox.fs.uploadFile(Buffer.from(content, "utf-8"), path);
      return { content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${path}` }] };
    },
  );
}

export function createFileListTool(sandbox: Sandbox) {
  return tool(
    "file_list",
    "List files and directories in a workspace path",
    { path: z.string().describe("Absolute directory path within /workspace/") },
    async ({ path }) => {
      validatePath(path);
      const entries = await sandbox.fs.listFiles(path);
      const listing = entries.map((e) => e.name).join("\n");
      return { content: [{ type: "text" as const, text: listing || "(empty directory)" }] };
    },
    { annotations: { readOnlyHint: true } },
  );
}

// --- Shell tool ---

export function createShellExecTool(sandbox: Sandbox) {
  return tool(
    "shell_exec",
    "Execute a shell command in the sandbox",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory (defaults to /workspace)"),
    },
    async ({ command, cwd }) => {
      const workDir = cwd ?? WORKSPACE_PREFIX;
      if (cwd) validatePath(cwd);
      const result = await sandbox.process.executeCommand(command, workDir);
      const output = [
        `exit_code: ${result.exitCode}`,
        result.result,
      ].join("\n");
      return { content: [{ type: "text" as const, text: output }] };
    },
  );
}

// --- Git tools ---

export function createGitStatusTool(sandbox: Sandbox) {
  return tool(
    "git_status",
    "Get git status of the workspace repository",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
    },
    async ({ path }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      const status = await sandbox.git.status(repoPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } },
  );
}

export function createGitAddTool(sandbox: Sandbox) {
  return tool(
    "git_add",
    "Stage files for commit",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
      files: z.array(z.string()).describe("Files to stage"),
    },
    async ({ path, files }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      await sandbox.git.add(repoPath, files);
      return { content: [{ type: "text" as const, text: `Staged ${files.length} file(s)` }] };
    },
  );
}

export function createGitCommitTool(sandbox: Sandbox) {
  return tool(
    "git_commit",
    "Create a git commit",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
      message: z.string().describe("Commit message"),
      author: z.string().describe("Author name"),
      email: z.string().describe("Author email"),
    },
    async ({ path, message, author, email }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      const result = await sandbox.git.commit(repoPath, message, author, email);
      return { content: [{ type: "text" as const, text: `Committed: ${result.sha}` }] };
    },
  );
}

export function createGitPushTool(sandbox: Sandbox) {
  return tool(
    "git_push",
    "Push commits to remote",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
    },
    async ({ path }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      await sandbox.git.push(repoPath);
      return { content: [{ type: "text" as const, text: "Pushed to remote" }] };
    },
  );
}

export function createGitDiffTool(sandbox: Sandbox) {
  return tool(
    "git_diff",
    "Show git diff",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
      args: z.string().optional().describe("Additional git diff arguments (e.g. '--cached', 'HEAD~1')"),
    },
    async ({ path, args }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      const cmd = args ? `git diff ${args}` : "git diff";
      const result = await sandbox.process.executeCommand(cmd, repoPath);
      return { content: [{ type: "text" as const, text: result.result || "(no changes)" }] };
    },
    { annotations: { readOnlyHint: true } },
  );
}

export function createGitCreateBranchTool(sandbox: Sandbox) {
  return tool(
    "git_create_branch",
    "Create a new git branch",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
      name: z.string().describe("Branch name to create"),
    },
    async ({ path, name }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      await sandbox.git.createBranch(repoPath, name);
      return { content: [{ type: "text" as const, text: `Created branch: ${name}` }] };
    },
  );
}

export function createGitCheckoutTool(sandbox: Sandbox) {
  return tool(
    "git_checkout",
    "Switch to a git branch",
    {
      path: z.string().optional().describe("Repository path (defaults to /workspace)"),
      branch: z.string().describe("Branch to switch to"),
    },
    async ({ path, branch }) => {
      const repoPath = path ?? WORKSPACE_PREFIX;
      if (path) validatePath(path);
      await sandbox.git.checkoutBranch(repoPath, branch);
      return { content: [{ type: "text" as const, text: `Checked out: ${branch}` }] };
    },
  );
}
