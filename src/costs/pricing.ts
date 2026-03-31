// Per-model pricing in USD per 1M tokens (input and output).
// Source URLs noted per provider.

export interface TokenPricing {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
}

// Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
// OpenAI:    https://openai.com/api/pricing/

export const PRICING: Record<string, TokenPricing> = {
  // --- Anthropic ---
  "claude-opus-4-6":   { input: 5.00,  output: 25.00 },
  "claude-sonnet-4-6": { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5":  { input: 1.00,  output: 5.00  },

  // --- OpenAI (Codex) ---
  "gpt-5.4":      { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini": { input: 0.75,  output: 4.50  },
};
