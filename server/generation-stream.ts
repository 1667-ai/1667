import { GenerationResultError } from "./errors.js";
import { streamCompletion, type PromptPlan, type TokenProbabilityCollector } from "./providers.js";
import type { GenerationSettings } from "../shared/types.js";
import type { PromptCacheRequest } from "./provider-cache-policy.js";
import type { StorySamplingBias } from "./sampling-phrase-bias.js";

interface ModelOutputFilter {
  push(delta: string): string;
  finish(): string;
}

export type DeltaConsumer = (text: string) => void | Promise<void>;

/** `streamModel`'s optional trailing values, grouped for the same reason as
 * `StreamCompletionOptions` (server/providers.ts, issue #341): `output`,
 * `providerStarted`, and `promptCache` were already three trailing
 * optionals, and `storySampling` would have made a fourth positional
 * parameter tacked on after them. */
export interface StreamModelOptions {
  readonly output?: ModelOutputFilter;
  readonly providerStarted?: () => void | Promise<void>;
  readonly promptCache?: PromptCacheRequest;
  readonly storySampling?: StorySamplingBias;
  readonly tokenProbabilities?: TokenProbabilityCollector;
}

/** Transport-neutral model stream. null means cancellation; failures throw. */
export async function streamModel(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  onDelta: DeltaConsumer,
  options: StreamModelOptions = {}
): Promise<string | null> {
  const { output, providerStarted, promptCache, storySampling, tokenProbabilities } = options;
  let text = "";
  const emit = async (delta: string) => {
    if (delta.length === 0) return;
    text += delta;
    await onDelta(delta);
  };
  try {
    for await (const delta of streamCompletion(settings, prompt, signal, {
      providerStarted,
      promptCache,
      storySampling,
      tokenProbabilities
    })) {
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
