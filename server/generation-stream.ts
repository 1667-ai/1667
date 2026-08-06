import { GenerationResultError, ProviderError } from "./errors.js";
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

/** Transport-neutral model stream. null means the stream was interrupted by
 * cancellation; a completed stream and a classified provider failure keep
 * their result even when the signal changes in the same turn. */
export async function streamModel(
  settings: GenerationSettings,
  prompt: PromptPlan,
  signal: AbortSignal,
  onDelta: DeltaConsumer,
  options: StreamModelOptions = {}
): Promise<string | null> {
  const { output, providerStarted, promptCache, storySampling, tokenProbabilities } = options;
  const outcome: { finishReason: "stop" | "length" | null } = {
    finishReason: null
  };
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
      tokenProbabilities,
      outcome
    })) {
      await emit(output?.push(delta) ?? delta);
    }
    // Some transports, including dry-run, end their iterator normally on
    // cancellation. Only a provider terminal marks that normal return as a
    // completed response; otherwise the streamed prefix remains partial.
    if (signal.aborted && outcome.finishReason === null) return null;
    if (output !== undefined) await emit(output.finish());
  } catch (error) {
    // The provider already classified this failure. A caller abort that races
    // the throw cannot turn rejected output into settleable cancellation.
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) return null;
    throw error;
  }
  // The provider and the output filter both finished. Validate their completed
  // output even if Stop arrived during the final consumer backpressure wait.
  if (text.trim().length === 0) throw new GenerationResultError(502, "The model returned no text.");
  return text;
}
