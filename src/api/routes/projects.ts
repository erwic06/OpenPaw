import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import { getAllProjects, getProject } from "../../db/index.ts";

export function projectRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/projects",
      handler: (ctx) => {
        return jsonResponse({ data: getAllProjects(ctx.deps.db) });
      },
    },
    {
      method: "GET",
      pattern: "/api/projects/:id",
      handler: (ctx) => {
        const project = getProject(ctx.deps.db, ctx.params.id);
        if (!project) return errorResponse("Project not found", 404);
        return jsonResponse({ data: project });
      },
    },
  ];
}
