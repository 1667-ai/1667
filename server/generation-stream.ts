import { GenerationResultError, ServiceError } from "./errors.js";
import { streamCompletion, type PromptPlan } from "./providers.js";
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
  promptCache?: PromptCacheRequest
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
      promptCache
    )) {
      await emit(output?.push(delta) ?? delta);
    }
  } catch (error) {
    if (signal.aborted) {
      throwIfUncertainAbort(signal);
      return null;
    }
    throw error;
  }
  if (output !== undefined) await emit(output.finish());
  if (signal.aborted) {
    throwIfUncertainAbort(signal);
    return null;
  }
  if (text.trim().length === 0) throw new GenerationResultError(502, "The model returned no text.");
  return text;
}

/** Worker deadlines/shutdowns are not user-confirmed cancellation. Preserve
 * their durable ambiguity instead of converting them into completed nulls. */
export function throwIfUncertainAbort(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof ServiceError
    && (reason.code === "mutation_outcome_unknown" || reason.code === "generation_outcome_unknown")) {
    throw reason;
  }
}
