import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import { getPendingGates } from "../../db/index.ts";

export function gateRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/gates/pending",
      handler: (ctx) => {
        return jsonResponse({ data: getPendingGates(ctx.deps.db) });
      },
    },
    {
      method: "POST",
      pattern: "/api/gates/:id/decide",
      handler: async (ctx) => {
        const { decision, feedback } = (ctx.body ?? {}) as {
          decision?: string;
          feedback?: string;
        };
        if (!decision || !["approved", "denied"].includes(decision)) {
          return errorResponse("decision must be 'approved' or 'denied'", 400);
        }
        if (!ctx.deps.resolveGateFn) {
          return errorResponse("Gate resolution not available", 501);
        }
        const result = await ctx.deps.resolveGateFn(
          ctx.params.id,
          decision as "approved" | "denied",
          feedback,
        );
        if (!result.success) {
          const status = result.error === "gate not found" ? 404 : 400;
          return errorResponse(result.error!, status);
        }
        return jsonResponse({ data: { gateId: ctx.params.id, decision } });
      },
    },
  ];
}
