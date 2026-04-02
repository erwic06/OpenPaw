import { describe, it, expect } from "bun:test";
import { estimateResearchCost, formatCostEstimate } from "../src/research/estimator.ts";
import { DEPTH_CONFIGS } from "../src/research/types.ts";

describe("estimateResearchCost", () => {
  it("returns correct estimate for depth 1", () => {
    const est = estimateResearchCost(1, "test query");
    expect(est.depth).toBe(1);
    expect(est.estimatedCostRange).toEqual([0.05, 0.10]);
    expect(est.estimatedTokens).toBeGreaterThan(0);
  });

  it("returns correct estimate for depth 10", () => {
    const est = estimateResearchCost(10, "deep research topic");
    expect(est.depth).toBe(10);
    expect(est.estimatedCostRange).toEqual([8.00, 12.00]);
    expect(est.estimatedTokens).toBeGreaterThan(60_000);
  });

  it("returns valid estimates for all depth levels", () => {
    for (let d = 1; d <= 10; d++) {
      const est = estimateResearchCost(d, "a query");
      expect(est.depth).toBe(d);
      expect(est.estimatedCostRange[0]).toBeLessThanOrEqual(est.estimatedCostRange[1]);
      expect(est.estimatedTokens).toBeGreaterThan(DEPTH_CONFIGS[d].outputTokenBudget);
    }
  });

  it("throws for invalid depth 0", () => {
    expect(() => estimateResearchCost(0, "test")).toThrow("Invalid depth level: 0");
  });

  it("throws for invalid depth 11", () => {
    expect(() => estimateResearchCost(11, "test")).toThrow("Invalid depth level: 11");
  });

  it("token estimate increases with longer prompt", () => {
    const short = estimateResearchCost(5, "short");
    const long = estimateResearchCost(5, "a".repeat(4000));
    expect(long.estimatedTokens).toBeGreaterThan(short.estimatedTokens);
  });

  it("cost range scales with depth", () => {
    const low = estimateResearchCost(1, "test");
    const high = estimateResearchCost(10, "test");
    expect(high.estimatedCostRange[1]).toBeGreaterThan(low.estimatedCostRange[1]);
  });
});

describe("formatCostEstimate", () => {
  it("formats estimate as readable string", () => {
    const est = estimateResearchCost(5, "quantum computing trends");
    const formatted = formatCostEstimate(est, "quantum computing trends");
    expect(formatted).toContain("depth 5/10");
    expect(formatted).toContain("$0.50");
    expect(formatted).toContain("$1.00");
    expect(formatted).toContain("quantum computing trends");
  });

  it("truncates long prompts in format", () => {
    const longPrompt = "x".repeat(500);
    const est = estimateResearchCost(3, longPrompt);
    const formatted = formatCostEstimate(est, longPrompt);
    expect(formatted).toContain("...");
    expect(formatted.length).toBeLessThan(500);
  });

  it("does not truncate short prompts", () => {
    const prompt = "a short topic";
    const est = estimateResearchCost(2, prompt);
    const formatted = formatCostEstimate(est, prompt);
    expect(formatted).toContain("a short topic");
    expect(formatted).not.toContain("...");
  });
});
