import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import { getDailySpendByService, getSessionCost, getDailySpend } from "../../db/index.ts";

export function costRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/cost/daily",
      handler: (ctx) => {
        const date = ctx.query.get("date");
        const breakdown = getDailySpendByService(ctx.deps.db, date ?? undefined);
        const today = date ?? new Date().toISOString().slice(0, 10);
        const total = getDailySpend(ctx.deps.db, today);
        return jsonResponse({ data: { date: today, total, breakdown } });
      },
    },
    {
      method: "GET",
      pattern: "/api/cost/session/:id",
      handler: (ctx) => {
        const cost = getSessionCost(ctx.deps.db, ctx.params.id);
        return jsonResponse({ data: { sessionId: ctx.params.id, cost } });
      },
    },
  ];
}
