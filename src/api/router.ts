import type { Route, ApiContext, ApiDeps } from "./types.ts";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const pathPart = pathParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(pathPart);
    } else if (pp !== pathPart) {
      return null;
    }
  }
  return params;
}

function hasBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

export function createRouter(
  routes: Route[],
  deps: ApiDeps,
): (req: Request) => Response | Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const method = req.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, cf-access-jwt-assertion",
        },
      });
    }

    for (const route of routes) {
      const params = matchPattern(route.pattern, url.pathname);
      if (params !== null && route.method === method) {
        let body: unknown = null;
        if (hasBody(method)) {
          try {
            body = await req.json();
          } catch {
            body = null;
          }
        }
        const ctx: ApiContext = { params, query: url.searchParams, body, deps };
        try {
          return await route.handler(ctx);
        } catch (err) {
          console.error(`[api] handler error: ${err}`);
          return errorResponse("Internal server error", 500);
        }
      }
    }

    // Check if path matches any route with different method
    const pathMatched = routes.some(
      (r) => matchPattern(r.pattern, url.pathname) !== null,
    );
    if (pathMatched) return errorResponse("Method not allowed", 405);
    return errorResponse("Not found", 404);
  };
}
