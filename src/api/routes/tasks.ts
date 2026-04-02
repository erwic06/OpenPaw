import { readFileSync } from "fs";
import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import { getSessionsForTask } from "../../db/index.ts";
import { parsePlan } from "../../plan/parser.ts";

export function taskRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/tasks/:id",
      handler: (ctx) => {
        if (!ctx.deps.planPath) return errorResponse("Plan path not configured", 501);
        try {
          const content = readFileSync(ctx.deps.planPath, "utf-8");
          const tasks = parsePlan(content);
          const task = tasks.find((t) => t.id === ctx.params.id);
          if (!task) return errorResponse("Task not found", 404);
          return jsonResponse({ data: task });
        } catch {
          return errorResponse("Failed to read plan", 500);
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/tasks/:id/sessions",
      handler: (ctx) => {
        const sessions = getSessionsForTask(ctx.deps.db, ctx.params.id);
        return jsonResponse({ data: sessions });
      },
    },
    {
      method: "POST",
      pattern: "/api/tasks",
      handler: async (ctx) => {
        const { type, prompt, depth, projectName } = (ctx.body ?? {}) as {
          type?: string;
          prompt?: string;
          depth?: number;
          projectName?: string;
        };

        if (!type || !["research", "coding"].includes(type)) {
          return errorResponse("type must be 'research' or 'coding'", 400);
        }
        if (!prompt?.trim()) {
          return errorResponse("prompt is required", 400);
        }

        if (type === "research") {
          if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 10)) {
            return errorResponse("depth must be integer 1-10", 400);
          }
          if (!ctx.deps.createResearchTask) {
            return errorResponse("Not yet available", 501);
          }
          const taskId = await ctx.deps.createResearchTask({ prompt, depth: depth ?? 5 });
          return jsonResponse({ data: { taskId, status: "accepted" } });
        }

        if (type === "coding") {
          if (!projectName?.trim()) {
            return errorResponse("projectName is required for coding tasks", 400);
          }
          if (!ctx.deps.createCodingTask) {
            return errorResponse("Not yet available", 501);
          }
          const taskId = await ctx.deps.createCodingTask({ projectName, prompt });
          return jsonResponse({ data: { taskId, status: "accepted" } });
        }

        return errorResponse("Unknown task type", 400);
      },
    },
    {
      method: "POST",
      pattern: "/api/projects",
      handler: async (ctx) => {
        const { name, description } = (ctx.body ?? {}) as {
          name?: string;
          description?: string;
        };

        if (!name?.trim()) {
          return errorResponse("name is required", 400);
        }
        if (!ctx.deps.createProject) {
          return errorResponse("Not yet available", 501);
        }
        const projectId = await ctx.deps.createProject({
          name,
          description: description ?? "",
        });
        return jsonResponse({ data: { projectId, status: "accepted" } });
      },
    },
  ];
}
