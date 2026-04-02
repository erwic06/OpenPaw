import type { Route } from "../types.ts";
import { jsonResponse, errorResponse } from "../router.ts";
import {
  getPendingCommunications,
  getCommunicationById,
  updatePendingCommunication,
  getRecentCommunications,
} from "../../db/index.ts";

export function communicationRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/communications/pending",
      handler: (ctx) => {
        return jsonResponse({ data: getPendingCommunications(ctx.deps.db) });
      },
    },
    {
      method: "GET",
      pattern: "/api/communications/recent",
      handler: (ctx) => {
        const limitStr = ctx.query.get("limit");
        const limit = limitStr ? parseInt(limitStr, 10) : 50;
        return jsonResponse({ data: getRecentCommunications(ctx.deps.db, limit) });
      },
    },
    {
      method: "GET",
      pattern: "/api/communications/:id",
      handler: (ctx) => {
        const comm = getCommunicationById(ctx.deps.db, ctx.params.id);
        if (!comm) return errorResponse("Communication not found", 404);
        return jsonResponse({ data: comm });
      },
    },
    {
      method: "POST",
      pattern: "/api/communications/:id/decide",
      handler: (ctx) => {
        const { decision, edited_content } = (ctx.body ?? {}) as {
          decision?: string;
          edited_content?: string;
        };
        if (
          !decision ||
          !["approved", "approved_edited", "rejected"].includes(decision)
        ) {
          return errorResponse(
            "decision must be 'approved', 'approved_edited', or 'rejected'",
            400,
          );
        }
        const comm = getCommunicationById(ctx.deps.db, ctx.params.id);
        if (!comm) return errorResponse("Communication not found", 404);
        if (comm.decision)
          return errorResponse("Communication already decided", 400);
        if (decision === "approved_edited" && !edited_content) {
          return errorResponse(
            "edited_content required for approved_edited decision",
            400,
          );
        }
        updatePendingCommunication(
          ctx.deps.db,
          ctx.params.id,
          decision,
          edited_content,
        );
        return jsonResponse({
          data: { communicationId: ctx.params.id, decision },
        });
      },
    },
  ];
}
