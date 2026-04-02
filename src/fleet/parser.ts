import type { Provider } from "../agents/types.ts";
import type {
  AgentDefinition,
  ScheduleConfig,
  OutputDestination,
  AdapterConfig,
  ToolConfig,
} from "./types.ts";

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google"];

export function parseAgentDefinition(
  content: string,
  configPath: string,
): AgentDefinition {
  const name = extractTitle(content);
  const id = extractIdFromPath(configPath);
  const sections = extractSections(content);

  const identity = parseIdentity(sections["Identity"]);
  const schedule = parseSchedule(sections["Schedule"]);
  const tools = parseTools(sections["Tools"]);
  const output = parseOutput(sections["Output"]);
  const depth = parseDepth(sections["Depth"]);
  const budget = parseBudget(sections["Budget"]);
  const adapter = parseAdapter(sections["Adapter"]);

  return {
    id,
    name,
    configPath,
    agentType: identity.agentType,
    model: identity.model,
    provider: identity.provider,
    description: (sections["Description"] || "").trim(),
    schedule,
    tools,
    input: (sections["Input"] || "").trim(),
    outputDestinations: output,
    depth,
    budgetPerRun: budget,
    adapterConfig: adapter,
    enabled: true,
  };
}

function extractTitle(content: string): string {
  const match = content.match(/^# (.+)$/m);
  if (!match) {
    throw new Error("Agent definition must have an H1 title (# Agent Name)");
  }
  return match[1].trim();
}

function extractIdFromPath(configPath: string): string {
  // agents/tbpn-digest/agent.md → "tbpn-digest"
  const parts = configPath.replace(/\\/g, "/").split("/");
  const agentMdIndex = parts.lastIndexOf("agent.md");
  if (agentMdIndex < 1) {
    throw new Error(
      `Cannot extract agent ID from path: ${configPath} (expected agents/<name>/agent.md)`,
    );
  }
  return parts[agentMdIndex - 1];
}

function extractSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /^## (.+)$/gm;
  const matches: { heading: string; index: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    matches.push({ heading: m[1].trim(), index: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index - matches[i + 1].heading.length - 3 : content.length;
    sections[matches[i].heading] = content.slice(start, end);
  }

  return sections;
}

interface Identity {
  agentType: string;
  model: string;
  provider: Provider;
}

function parseKeyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (match) {
      result[match[1].trim()] = match[2].trim();
    }
  }
  return result;
}

function parseIdentity(section: string | undefined): Identity {
  if (!section) {
    throw new Error("Missing required ## Identity section");
  }
  const kv = parseKeyValues(section);

  const agentType = kv["agent_type"];
  if (!agentType) {
    throw new Error("Identity section must include agent_type");
  }

  const model = kv["model"];
  if (!model) {
    throw new Error("Identity section must include model");
  }

  const provider = kv["provider"] as Provider;
  if (!provider) {
    throw new Error("Identity section must include provider");
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(
      `Invalid provider "${provider}". Must be one of: ${VALID_PROVIDERS.join(", ")}`,
    );
  }

  return { agentType, model, provider };
}

function parseSchedule(section: string | undefined): ScheduleConfig | null {
  if (!section || !section.trim()) return null;

  const kv = parseKeyValues(section);

  if (kv["cron"]) {
    const expr = kv["cron"].replace(/^["']|["']$/g, "");
    const fields = expr.split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(
        `Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
      );
    }
    return { type: "cron", expression: expr };
  }

  if (kv["on_commit"]) {
    return { type: "event", expression: `on_commit:${kv["on_commit"]}` };
  }
  if (kv["on_task_complete"]) {
    return {
      type: "event",
      expression: `on_task_complete:${kv["on_task_complete"]}`,
    };
  }
  if (kv["on_gate_approved"]) {
    return {
      type: "event",
      expression: `on_gate_approved:${kv["on_gate_approved"]}`,
    };
  }

  return { type: "manual" };
}

function parseTools(section: string | undefined): ToolConfig[] {
  if (!section || !section.trim()) return [];

  const tools: ToolConfig[] = [];
  const lines = section.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match "- toolname:" or "- toolname: true/false"
    const toolMatch = line.match(/^- (\w[\w_]*):\s*(.*)$/);
    if (!toolMatch) continue;

    const name = toolMatch[1];
    const rest = toolMatch[2].trim();

    if (!rest || rest === "true") {
      // Check for nested config on subsequent indented lines
      const options: Record<string, unknown> = {};
      let j = i + 1;
      while (j < lines.length) {
        const nested = lines[j].match(/^\s{2,}(\w[\w_]*):\s*(.+)$/);
        if (!nested) break;
        const val = nested[2].trim();
        // Parse booleans and numbers
        if (val === "true") options[nested[1]] = true;
        else if (val === "false") options[nested[1]] = false;
        else if (/^\d+$/.test(val)) options[nested[1]] = parseInt(val, 10);
        else options[nested[1]] = val;
        j++;
      }

      tools.push(
        Object.keys(options).length > 0 ? { name, options } : { name },
      );
      i = j - 1;
    } else if (rest === "false") {
      // Explicitly disabled tool, skip
      continue;
    } else {
      tools.push({ name });
    }
  }

  return tools;
}

function parseOutput(section: string | undefined): OutputDestination[] {
  if (!section || !section.trim()) return [];

  const destinations: OutputDestination[] = [];

  for (const line of section.split("\n")) {
    const match = line.match(/^- (\w+):\s*(.+)$/);
    if (!match) continue;

    const destType = match[1].trim();
    const rest = match[2].trim();

    if (destType === "telegram") {
      const format = rest as "summary" | "full_report";
      destinations.push({ type: "telegram", format });
    } else if (destType === "github") {
      // github: full_report (path: research/tbpn/)
      const pathMatch = rest.match(
        /^(summary|full_report)\s*(?:\(path:\s*(.+?)\))?$/,
      );
      if (pathMatch) {
        destinations.push({
          type: "github",
          format: pathMatch[1] as "summary" | "full_report",
          path: pathMatch[2] || "",
        });
      }
    } else if (destType === "webapp") {
      destinations.push({ type: "webapp" });
    } else if (destType === "notion") {
      // Notion is mentioned in design doc but type only supports telegram/github/webapp.
      // Skip silently for forward compatibility.
      continue;
    }
  }

  return destinations;
}

function parseDepth(section: string | undefined): number | null {
  if (!section || !section.trim()) return null;

  const kv = parseKeyValues(section);
  const level = kv["level"];
  if (!level) return null;

  const num = parseInt(level, 10);
  if (isNaN(num) || num < 1 || num > 10) {
    throw new Error(`Depth level must be an integer 1-10, got "${level}"`);
  }
  return num;
}

function parseBudget(section: string | undefined): number {
  if (!section || !section.trim()) return 0;

  const kv = parseKeyValues(section);
  const raw = kv["max_cost_per_run"];
  if (!raw) return 0;

  const match = raw.match(/^\$?([\d.]+)$/);
  if (!match) {
    throw new Error(
      `Invalid budget format "${raw}". Expected $N.NN or N.NN`,
    );
  }
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount < 0) {
    throw new Error(`Budget must be a positive number, got "${raw}"`);
  }
  return amount;
}

function parseAdapter(section: string | undefined): AdapterConfig {
  if (!section || !section.trim()) return { type: "llm" };

  const kv = parseKeyValues(section);
  const adapterType = kv["type"];

  if (!adapterType || adapterType === "llm") {
    return { type: "llm" };
  }

  if (adapterType === "service") {
    const baseUrl = kv["base_url"];
    if (!baseUrl) {
      throw new Error("Service adapter requires base_url");
    }
    return {
      type: "service",
      baseUrl,
      auth: kv["auth"] || "",
      healthCheck: kv["health_check"] || "/health",
      triggerEndpoint: kv["trigger_endpoint"] || "/trigger",
      statusEndpoint: kv["status_endpoint"] || "/status",
      outputEndpoint: kv["output_endpoint"] || "/output",
    };
  }

  throw new Error(
    `Invalid adapter type "${adapterType}". Must be "llm" or "service"`,
  );
}
