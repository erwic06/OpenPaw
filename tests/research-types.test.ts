import { describe, it, expect } from "bun:test";
import { DEPTH_CONFIGS, parseResearchBrief } from "../src/research/index.ts";
import type { DepthConfig } from "../src/research/index.ts";

describe("DEPTH_CONFIGS", () => {
  it("covers all 10 depth levels", () => {
    for (let d = 1; d <= 10; d++) {
      expect(DEPTH_CONFIGS[d]).toBeDefined();
    }
  });

  it("has increasing output token budgets", () => {
    for (let d = 1; d < 10; d++) {
      expect(DEPTH_CONFIGS[d].outputTokenBudget).toBeLessThan(
        DEPTH_CONFIGS[d + 1].outputTokenBudget,
      );
    }
  });

  it("has non-decreasing minimum sources", () => {
    for (let d = 1; d < 10; d++) {
      expect(DEPTH_CONFIGS[d].minSources).toBeLessThanOrEqual(
        DEPTH_CONFIGS[d + 1].minSources,
      );
    }
  });

  it("has increasing cost ranges", () => {
    for (let d = 1; d < 10; d++) {
      const [lowCur] = DEPTH_CONFIGS[d].estimatedCostRange;
      const [lowNext] = DEPTH_CONFIGS[d + 1].estimatedCostRange;
      expect(lowCur).toBeLessThanOrEqual(lowNext);
    }
  });

  it("has valid cost range structure (low <= high)", () => {
    for (let d = 1; d <= 10; d++) {
      const [low, high] = DEPTH_CONFIGS[d].estimatedCostRange;
      expect(low).toBeLessThanOrEqual(high);
    }
  });
});

const SAMPLE_BRIEF = `# Research Brief: TypeScript Build Tools

## Executive Summary
TypeScript build tools have evolved significantly. Bun and esbuild dominate performance benchmarks [1].

## Section 1: Build Performance
**Confidence: high**

Bun achieves sub-second builds for most projects [1]. esbuild remains competitive at 2-3x slower [2].

## Section 2: Ecosystem Compatibility
**Confidence: medium**

Some packages have compatibility issues with Bun's module resolution [3]. The community is actively addressing these gaps.

## Open Questions
- How does Bun perform with monorepos at scale?
- What is the long-term maintenance commitment?

## Sources

[1] Bun Build Performance — https://bun.sh/docs/bundler — Accessed 2026-04-01
[2] esbuild Benchmarks — https://esbuild.github.io/faq/#benchmark-details — Accessed 2026-04-01
[3] Bun Compatibility Tracker — https://github.com/oven-sh/bun/issues/123 — Accessed 2026-03-30
`;

describe("parseResearchBrief", () => {
  const meta = { taskId: "R.1", model: "gemini-3.1-pro-preview", costUsd: 0.75 };

  it("extracts the title from the heading", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.title).toBe("TypeScript Build Tools");
  });

  it("extracts the executive summary", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.executiveSummary).toContain("TypeScript build tools");
    expect(brief.executiveSummary).toContain("[1]");
  });

  it("extracts sections with headings and content", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.sections.length).toBe(2);
    expect(brief.sections[0].heading).toContain("Build Performance");
    expect(brief.sections[1].heading).toContain("Ecosystem Compatibility");
  });

  it("extracts confidence levels from sections", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.sections[0].confidence).toBe("high");
    expect(brief.sections[1].confidence).toBe("medium");
  });

  it("extracts citation numbers from sections", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.sections[0].citations).toContain(1);
    expect(brief.sections[0].citations).toContain(2);
    expect(brief.sections[1].citations).toContain(3);
  });

  it("extracts open questions", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.openQuestions).toContain("monorepos");
    expect(brief.openQuestions).toContain("maintenance");
  });

  it("extracts sources with id, url, title, and date", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.sources.length).toBe(3);

    expect(brief.sources[0].id).toBe(1);
    expect(brief.sources[0].title).toBe("Bun Build Performance");
    expect(brief.sources[0].url).toBe("https://bun.sh/docs/bundler");
    expect(brief.sources[0].accessDate).toBe("2026-04-01");

    expect(brief.sources[2].id).toBe(3);
    expect(brief.sources[2].accessDate).toBe("2026-03-30");
  });

  it("preserves metadata from caller", () => {
    const brief = parseResearchBrief(SAMPLE_BRIEF, meta);
    expect(brief.taskId).toBe("R.1");
    expect(brief.model).toBe("gemini-3.1-pro-preview");
    expect(brief.costUsd).toBe(0.75);
  });

  it("handles brief with no sources section", () => {
    const noSources = `# Research Brief: Quick Answer\n\n## Executive Summary\nShort answer.\n`;
    const brief = parseResearchBrief(noSources, meta);
    expect(brief.sources).toEqual([]);
    expect(brief.title).toBe("Quick Answer");
  });

  it("handles brief with no explicit confidence", () => {
    const noConf = `# Research Brief: Test\n\n## Executive Summary\nSummary.\n\n## Section 1: Stuff\nContent here.\n`;
    const brief = parseResearchBrief(noConf, meta);
    expect(brief.sections[0].confidence).toBe("medium"); // default
  });

  it("deduplicates citation numbers", () => {
    const repeated = `# Research Brief: Test\n\n## Executive Summary\nHi.\n\n## Section 1: Dupes\n**Confidence: high**\nFoo [1] bar [1] baz [2] [1].\n`;
    const brief = parseResearchBrief(repeated, meta);
    expect(brief.sections[0].citations).toEqual([1, 2]);
  });
});
