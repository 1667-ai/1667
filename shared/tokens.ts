import { formatFactsMessage } from "./story-facts.js";
import type { EffectiveStoryFact } from "./fact-state.js";
import type { StoryNode } from "./types.js";

/**
 * Rough token estimate. Deliberately approximate — the point is to warn you before
 * a long story overruns the model's context, not to bill anyone. ~4 characters per
 * token holds up well for English prose; every estimate is shown with a "~".
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What a "continue" would actually send: the system prompt, then every part as an
 * (instruction, text) pair, then the new instruction. Mirrors handleContinue's
 * message assembly, so the number tracks the real prompt.
 */
export function estimatePromptTokens(
  systemPrompt: string,
  parts: readonly StoryNode[],
  instruction: string,
  facts: readonly EffectiveStoryFact[]
): number {
  const body = parts.reduce((sum, part) => sum + estimateTokens(part.instruction) + estimateTokens(part.text), 0);
  const factsMessage = formatFactsMessage(facts);
  // A few tokens of per-message role framing that every provider adds.
  const framing = (parts.length * 2 + 2 + (factsMessage === null ? 0 : 1)) * 4;
  return estimateTokens(systemPrompt) + body + estimateTokens(instruction)
    + (factsMessage === null ? 0 : estimateTokens(factsMessage)) + framing;
}

export function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}
