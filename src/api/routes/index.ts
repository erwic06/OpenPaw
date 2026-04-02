import type { Route } from "../types.ts";
import { sessionRoutes } from "./sessions.ts";
import { gateRoutes } from "./gates.ts";
import { costRoutes } from "./costs.ts";
import { projectRoutes } from "./projects.ts";
import { communicationRoutes } from "./communications.ts";
import { taskRoutes } from "./tasks.ts";

export function allRoutes(): Route[] {
  return [
    { method: "GET", pattern: "/health", handler: () => new Response("ok") },
    ...sessionRoutes(),
    ...gateRoutes(),
    ...costRoutes(),
    ...projectRoutes(),
    ...communicationRoutes(),
    ...taskRoutes(),
  ];
}
