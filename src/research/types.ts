// --- Source reliability ---

export type SourceReliability =
  | "official"
  | "academic"
  | "reputable"
  | "community"
  | "unknown";

// --- Research brief types ---

export interface ResearchSource {
  id: number;
  url: string;
  title: string;
  accessDate: string;
  reliability: SourceReliability;
}

export interface ResearchSection {
  heading: string;
  content: string;
  confidence: "high" | "medium" | "low";
  citations: number[];
}

export interface ResearchBrief {
  taskId: string;
  title: string;
  depth: number;
  executiveSummary: string;
  sections: ResearchSection[];
  openQuestions: string;
  sources: ResearchSource[];
  generatedAt: string;
  model: string;
  costUsd: number;
}

// --- Depth configuration ---

export interface DepthConfig {
  outputTokenBudget: number;
  minSources: number;
  estimatedCostRange: [number, number];
}

export const DEPTH_CONFIGS: Record<number, DepthConfig> = {
  1:  { outputTokenBudget: 1_500,  minSources: 1, estimatedCostRange: [0.05, 0.10] },
  2:  { outputTokenBudget: 2_500,  minSources: 2, estimatedCostRange: [0.10, 0.15] },
  3:  { outputTokenBudget: 4_000,  minSources: 2, estimatedCostRange: [0.15, 0.30] },
  4:  { outputTokenBudget: 6_000,  minSources: 3, estimatedCostRange: [0.30, 0.50] },
  5:  { outputTokenBudget: 10_000, minSources: 3, estimatedCostRange: [0.50, 1.00] },
  6:  { outputTokenBudget: 14_000, minSources: 5, estimatedCostRange: [1.00, 1.50] },
  7:  { outputTokenBudget: 20_000, minSources: 5, estimatedCostRange: [1.50, 2.50] },
  8:  { outputTokenBudget: 30_000, minSources: 8, estimatedCostRange: [2.50, 4.00] },
  9:  { outputTokenBudget: 45_000, minSources: 8, estimatedCostRange: [4.00, 8.00] },
  10: { outputTokenBudget: 60_000, minSources: 12, estimatedCostRange: [8.00, 12.00] },
};

// --- Brief parser ---

/**
 * Parse a structured research brief from markdown output.
 * Expects the format defined in the researcher system prompt.
 */
export function parseResearchBrief(
  text: string,
  meta: { taskId: string; model: string; costUsd: number },
): ResearchBrief {
  const lines = text.split("\n");

  // Extract title from first heading
  const titleLine = lines.find((l) => /^#\s+Research Brief:/.test(l));
  const title = titleLine
    ? titleLine.replace(/^#\s+Research Brief:\s*/, "").trim()
    : "Untitled";

  // Extract executive summary
  const execSummary = extractSection(lines, "Executive Summary");

  // Extract sections (## headings that aren't special sections)
  const specialSections = new Set([
    "executive summary",
    "open questions",
    "sources",
  ]);
  const sections = extractAllSections(lines, specialSections);

  // Extract open questions
  const openQuestions = extractSection(lines, "Open Questions");

  // Extract sources
  const sources = extractSources(lines);

  return {
    taskId: meta.taskId,
    title,
    depth: 0, // Caller sets this from task config
    executiveSummary: execSummary,
    sections,
    openQuestions,
    sources,
    generatedAt: new Date().toISOString(),
    model: meta.model,
    costUsd: meta.costUsd,
  };
}

/** Extract content under a specific ## heading. */
function extractSection(lines: string[], heading: string): string {
  const headingLower = heading.toLowerCase();
  let capturing = false;
  const content: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      const sectionName = line.replace(/^##\s+/, "").trim().toLowerCase();
      if (sectionName === headingLower) {
        capturing = true;
        continue;
      } else if (capturing) {
        break;
      }
    }
    if (capturing) {
      content.push(line);
    }
  }

  return content.join("\n").trim();
}

/** Extract all non-special ## sections as ResearchSections. */
function extractAllSections(
  lines: string[],
  specialSections: Set<string>,
): ResearchSection[] {
  const sections: ResearchSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      // Flush previous section
      if (currentHeading !== null) {
        sections.push(buildSection(currentHeading, currentLines));
      }

      const heading = line.replace(/^##\s+/, "").trim();
      if (specialSections.has(heading.toLowerCase())) {
        currentHeading = null;
        currentLines = [];
      } else {
        currentHeading = heading;
        currentLines = [];
      }
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentHeading !== null) {
    sections.push(buildSection(currentHeading, currentLines));
  }

  return sections;
}

function buildSection(heading: string, lines: string[]): ResearchSection {
  const content = lines.join("\n").trim();

  // Extract confidence from **Confidence: xxx** line
  let confidence: "high" | "medium" | "low" = "medium";
  const confMatch = content.match(/\*\*Confidence:\s*(high|medium|low)\*\*/i);
  if (confMatch) {
    confidence = confMatch[1].toLowerCase() as "high" | "medium" | "low";
  }

  // Extract citation numbers [1], [2], etc.
  const citationMatches = content.match(/\[(\d+)\]/g) ?? [];
  const citations = [...new Set(citationMatches.map((m) => parseInt(m.slice(1, -1), 10)))];

  return { heading, content, confidence, citations };
}

/** Extract numbered sources from the Sources section. */
function extractSources(lines: string[]): ResearchSource[] {
  const sourcesContent = extractSection(lines, "Sources");
  if (!sourcesContent) return [];

  const sources: ResearchSource[] = [];
  // Match patterns like: [1] Title — URL — Accessed 2026-04-01
  // or: [1] Title - URL - Accessed 2026-04-01
  const sourceLines = sourcesContent.split("\n").filter((l) => /^\[(\d+)\]/.test(l.trim()));

  for (const line of sourceLines) {
    const idMatch = line.match(/^\[(\d+)\]/);
    if (!idMatch) continue;

    const id = parseInt(idMatch[1], 10);
    const rest = line.slice(idMatch[0].length).trim();

    // Split by " — " or " - " (em dash or hyphen separators)
    const parts = rest.split(/\s+[—–-]\s+/);

    const title = parts[0]?.trim() ?? "";
    const url = parts[1]?.trim() ?? "";
    const accessPart = parts[2]?.trim() ?? "";
    const dateMatch = accessPart.match(/(\d{4}-\d{2}-\d{2})/);
    const accessDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

    sources.push({
      id,
      url,
      title,
      accessDate,
      reliability: "unknown", // Reliability is assessed by the reviewer, not parsed
    });
  }

  return sources;
}
