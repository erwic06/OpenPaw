/**
 * BrowserUse Cloud API wrapper.
 *
 * Uses the BrowserUse Cloud API (v3) to run browser tasks and extract page content.
 * Cloud-only mode — no local Chromium required.
 */

const API_BASE = "https://api.browser-use.com/api/v3";
const DEFAULT_MAX_CONTENT_LENGTH = 10_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

export interface BrowserUseDeps {
  cloudApiKey: string;
  /** Override for testing. */
  fetchFn?: typeof fetch;
  /** Max content chars to return. Default 10000. */
  maxContentLength?: number;
}

export interface BrowserUseResult {
  url: string;
  title: string;
  content: string;
  error?: string;
}

interface SessionResponse {
  id: string;
  status: string;
  title: string | null;
  output: unknown;
  isTaskSuccessful: boolean | null;
  lastStepSummary: string | null;
}

/**
 * Browse a URL via BrowserUse Cloud API and return structured content.
 * Errors are returned in the result (never throws).
 */
export async function browseUrl(
  deps: BrowserUseDeps,
  url: string,
  options?: { action?: string },
): Promise<BrowserUseResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const maxLen = deps.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

  try {
    // Build the task instruction
    let task = `Navigate to ${url} and extract the full text content of the page.`;
    if (options?.action) {
      task += ` ${options.action}`;
    }
    task += " Return the page content as plain text.";

    // Create session
    const createRes = await fetchFn(`${API_BASE}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Browser-Use-API-Key": deps.cloudApiKey,
      },
      body: JSON.stringify({ task }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => createRes.statusText);
      return { url, title: "", content: "", error: `BrowserUse API error: ${createRes.status} ${errText}` };
    }

    const session = (await createRes.json()) as SessionResponse;
    const sessionId = session.id;

    // Poll for completion
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let result = session;

    while (!isTerminal(result.status) && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollRes = await fetchFn(`${API_BASE}/sessions/${sessionId}`, {
        headers: { "X-Browser-Use-API-Key": deps.cloudApiKey },
      });

      if (!pollRes.ok) {
        const errText = await pollRes.text().catch(() => pollRes.statusText);
        return { url, title: "", content: "", error: `BrowserUse poll error: ${pollRes.status} ${errText}` };
      }

      result = (await pollRes.json()) as SessionResponse;
    }

    if (!isTerminal(result.status)) {
      return { url, title: "", content: "", error: "BrowserUse session timed out" };
    }

    if (result.status === "error" || result.isTaskSuccessful === false) {
      return {
        url,
        title: result.title ?? "",
        content: "",
        error: result.lastStepSummary ?? "BrowserUse task failed",
      };
    }

    // Extract content from output
    const content = extractContent(result.output, maxLen);
    return {
      url,
      title: result.title ?? "",
      content,
    };
  } catch (err) {
    return {
      url,
      title: "",
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Returns a Gemini-compatible FunctionDeclaration for the browseUrl tool.
 */
export function getBrowserUseToolDeclaration(): {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
} {
  return {
    name: "browse_url",
    description:
      "Browse a web URL and extract its text content. Use this to research topics, read documentation, verify claims, or gather information from websites.",
    parameters: {
      type: "OBJECT",
      properties: {
        url: {
          type: "STRING",
          description: "The URL to browse and extract content from",
        },
        action: {
          type: "STRING",
          description:
            "Optional specific instruction for the browser, e.g. 'click the pricing tab' or 'scroll to the API section'",
        },
      },
      required: ["url"],
    },
  };
}

function isTerminal(status: string): boolean {
  return status === "stopped" || status === "error" || status === "timed_out";
}

function extractContent(output: unknown, maxLen: number): string {
  if (output == null) return "";
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n\n[Content truncated]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
