import { DEPTH_CONFIGS } from "./types.ts";

export interface CostEstimate {
  depth: number;
  estimatedTokens: number;
  estimatedCostRange: [number, number];
}

/**
 * Estimate research cost based on depth level and prompt length.
 * Uses DEPTH_CONFIGS token budgets and cost ranges.
 */
export function estimateResearchCost(depth: number, prompt: string): CostEstimate {
  const config = DEPTH_CONFIGS[depth];
  if (!config) {
    throw new Error(`Invalid depth level: ${depth}. Must be 1-10.`);
  }

  // ~4 chars per token for input, plus ~2000 tokens system prompt overhead
  const promptTokens = Math.ceil(prompt.length / 4);
  const systemOverhead = 2000;
  const estimatedTokens = promptTokens + systemOverhead + config.outputTokenBudget;

  return {
    depth,
    estimatedTokens,
    estimatedCostRange: config.estimatedCostRange,
  };
}

export function formatCostEstimate(estimate: CostEstimate, prompt: string): string {
  const [low, high] = estimate.estimatedCostRange;
  const preview = prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt;
  return [
    `Research Cost Estimate (depth ${estimate.depth}/10):`,
    `Estimated tokens: ~${estimate.estimatedTokens.toLocaleString()}`,
    `Cost range: $${low.toFixed(2)} \u2014 $${high.toFixed(2)}`,
    "",
    `Topic: ${preview}`,
  ].join("\n");
}
