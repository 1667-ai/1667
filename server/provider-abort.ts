import {
  GenerationCancelledError,
  GenerationStoppedError,
  ServiceError
} from "./errors.js";

export type ProviderAbort =
  | {
      readonly kind: "terminal";
      readonly error: GenerationStoppedError;
      readonly userInitiated: boolean;
    }
  | {
      readonly kind: "uncertain";
      readonly error: ServiceError;
    }
  | { readonly kind: "none" };

/** Classify the provider abort once for transports, receipts, and workers. */
export function classifyProviderAbort(signal: AbortSignal): ProviderAbort {
  if (!signal.aborted) return { kind: "none" };
  const reason = signal.reason;
  if (reason instanceof GenerationStoppedError) {
    return {
      kind: "terminal",
      error: reason,
      userInitiated: reason instanceof GenerationCancelledError
    };
  }
  if (reason instanceof ServiceError
    && (reason.code === "mutation_outcome_unknown"
      || reason.code === "generation_outcome_unknown")) {
    return { kind: "uncertain", error: reason };
  }
  return { kind: "none" };
}

export function providerAbortForError(
  signal: AbortSignal,
  error: unknown
): ProviderAbort {
  const abort = classifyProviderAbort(signal);
  if (abort.kind === "none") return abort;
  return error === signal.reason
    || error instanceof GenerationStoppedError
    || (error instanceof Error && error.name === "AbortError")
    ? abort
    : { kind: "none" };
}
