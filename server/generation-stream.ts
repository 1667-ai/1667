import { GenerationResultError } from "./errors.js";
import { streamCompletion, type PromptPlan, type TokenProbabilityCollector } from "./providers.js";
import type { GenerationSettings } from "../shared/types.js";
import type { PromptCacheRequest } from "./provider-cache-policy.js";

interface ModelOutputFilter {
  push(delta: string): string;
  finish(): string;
}

export type DeltaConsumer = (text: string) => void | Promise<void>;

/** Transport-neutral model stream. null means cancellation; failures throw. */
export async function streamModel(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  onDelta: DeltaConsumer,
  output?: ModelOutputFilter,
  providerStarted?: () => void | Promise<void>,
  promptCache?: PromptCacheRequest,
  tokenProbabilities?: TokenProbabilityCollector
): Promise<string | null> {
  let text = "";
  const emit = async (delta: string) => {
    if (delta.length === 0) return;
    text += delta;
    await onDelta(delta);
  };
  try {
    for await (const delta of streamCompletion(
      settings,
      prompt,
      signal,
      undefined,
      providerStarted,
      promptCache,
      tokenProbabilities
    )) {
      await emit(output?.push(delta) ?? delta);
    }
    if (output !== undefined) await emit(output.finish());
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
  if (signal.aborted) return null;
  if (text.trim().length === 0) throw new GenerationResultError(502, "The model returned no text.");
  return text;
}
