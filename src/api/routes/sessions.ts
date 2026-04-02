import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import { getRecentSessions, getSessionById, getActiveSessions } from "../../db/index.ts";

export function sessionRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/sessions",
      handler: (ctx) => {
        const limitStr = ctx.query.get("limit");
        const limit = limitStr ? parseInt(limitStr, 10) : 50;
        const active = ctx.query.get("active");
        if (active === "true") {
          return jsonResponse({ data: getActiveSessions(ctx.deps.db) });
        }
        return jsonResponse({ data: getRecentSessions(ctx.deps.db, limit) });
      },
    },
    {
      method: "GET",
      pattern: "/api/sessions/:id",
      handler: (ctx) => {
        const session = getSessionById(ctx.deps.db, ctx.params.id);
        if (!session) return errorResponse("Session not found", 404);
        return jsonResponse({ data: session });
      },
    },
  ];
}
