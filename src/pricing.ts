import type { ReplyCost } from "./shared";

/** US dollars per million tokens; `above` is the rate for prompts longer than `tokens`. */
type Price = { input: number; output: number; above?: { tokens: number; input: number; output: number } };

/**
 * Public list prices, checked 2026-11-11 (platform.claude.com/docs/en/about-claude/pricing and
 * aistudio.google.com/docs/pricing). Keyed by exact model id on purpose: a model that is not
 * listed here shows token counts without a dollar figure, rather than a guess from an older
 * model's price. The Gemini `-latest` aliases are priced as the models they pointed to on that
 * date (3.1 Pro, 3.8 Flash); Flash is listed to double on 2027-01-01.
 */
const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, above: { tokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-fable-5-2": { input: 8, output: 40 },
  "gemini-pro-latest": { input: 2, output: 12, above: { tokens: 200_000, input: 4, output: 18 } },
  "gemini-flash-latest": { input: 0.75, output: 3.75 }
};

/** Anthropic bills each web search; Google's first 5,000 a month are free, so those are not counted. */
const ANTHROPIC_SEARCH_USD = 0.01;

type Usage = { inputTokens?: number; outputTokens?: number };

/**
 * What one model call cost, estimated from the token counts the provider reported. Output
 * tokens include the model's reasoning. `usd` is null when the model's price is not known.
 */
export function costOf(modelId: string, usage: Usage, searches = 0): ReplyCost {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const price = PRICES[modelId];
  if (!price) return { modelId, inputTokens, outputTokens, searches, usd: null };
  const rate = price.above && inputTokens > price.above.tokens ? price.above : price;
  const searchFee = modelId.startsWith("claude-") ? searches * ANTHROPIC_SEARCH_USD : 0;
  const usd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000 + searchFee;
  return { modelId, inputTokens, outputTokens, searches, usd };
}
