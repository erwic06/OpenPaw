import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Sandbox } from "@daytonaio/sdk";

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
} from "./daytona-tools.ts";

export { validatePath } from "./daytona-tools.ts";

/**
 * Create an MCP server with all Daytona sandbox tools.
 * The returned config is passed to query() via the mcpServers option.
 */
export function createDaytonaToolServer(sandbox: Sandbox) {
  return createSdkMcpServer({
    name: "daytona-tools",
    version: "1.0.0",
    tools: [
      createFileReadTool(sandbox),
      createFileWriteTool(sandbox),
      createFileListTool(sandbox),
      createShellExecTool(sandbox),
      createGitStatusTool(sandbox),
      createGitAddTool(sandbox),
      createGitCommitTool(sandbox),
      createGitPushTool(sandbox),
      createGitDiffTool(sandbox),
      createGitCreateBranchTool(sandbox),
      createGitCheckoutTool(sandbox),
    ],
  });
}
