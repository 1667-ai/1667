import { apiErrorCode, isExplicitMutationUnsent } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import { WebBridgeTransportError } from "../../../client/web-bridge-transport.js";
import type { StoryPayload } from "../../../shared/types.js";
import { STORY_RELOADED_TOAST } from "../story/actions.js";
import { retryWhenBusy } from "./busy-retry.js";
import { errorMessage } from "./toasts.js";

/**
 * One story change with the conflict and unknown-outcome handling every
 * writer shares (tags, chapter breaks, summaries). Pure over `api`: no store,
 * no toast — the caller decides what each outcome shows.
 *
 * `send` makes the call (it is retried while the backend answers
 * `resource_busy`). After ANY failure the story is reloaded, because a failed
 * call can still move the story's version. `verify` reads that reload and says
 * whether the change is there anyway; it is only asked when the outcome is
 * unknown (the answer was lost), never after a plain verdict.
 */
export type StoryMutationOutcome<R extends object> =
  /** `reconciled` is true when the answer was lost and the reload proved the
   * change; `value` is then what `verify` found, not what `send` returned. */
  | { readonly kind: "saved"; readonly payload: StoryPayload; readonly value: R; readonly reconciled: boolean }
  /** The story changed elsewhere. `payload` is the reload (`null` if it failed). */
  | { readonly kind: "conflict"; readonly payload: StoryPayload | null }
  /** Nothing is known to have changed. */
  | { readonly kind: "failed"; readonly payload: StoryPayload | null; readonly error: unknown }
  /** The outcome is unknown and the reload that would tell failed too. */
  | { readonly kind: "unresolved"; readonly error: unknown };

const CONFLICT_CODES: ReadonlySet<string | null> = new Set(["conflict", "revision_conflict"]);

/** A failure that does not say whether the change was applied: the bridge
 * says the outcome is uncertain, the transport was lost, or the server says
 * so. This is checked before anything else: a bridge failure with an
 * uncertain outcome still carries a structured envelope, but that envelope is
 * not a verdict on the mutation. A plain structured failure is a verdict; an
 * unsent mutation is a verdict too. */
export function outcomeUnknown(error: unknown): boolean {
  if (error instanceof WebBridgeTransportError && error.mutationOutcome === "uncertain") return true;
  if (apiErrorCode(error) === "mutation_outcome_unknown") return true;
  if (isExplicitMutationUnsent(error)) return false;
  const structured = typeof error === "object" && error !== null
    && typeof (error as { failure?: unknown }).failure === "object"
    && (error as { failure?: unknown }).failure !== null;
  return !structured;
}

export async function runStoryMutation<R extends object>(
  api: StoryApi,
  storyId: string,
  send: () => Promise<R & { readonly payload: StoryPayload }>,
  verify: (reloaded: StoryPayload) => R | null
): Promise<StoryMutationOutcome<R>> {
  try {
    const result = await retryWhenBusy(send);
    return { kind: "saved", payload: result.payload, value: result, reconciled: false };
  } catch (error) {
    const reloaded = await api.loadStory(storyId).catch(() => null);
    if (CONFLICT_CODES.has(apiErrorCode(error))) return { kind: "conflict", payload: reloaded };
    if (!outcomeUnknown(error)) return { kind: "failed", payload: reloaded, error };
    if (reloaded === null) return { kind: "unresolved", error };
    const found = verify(reloaded);
    if (found !== null) return { kind: "saved", payload: reloaded, value: found, reconciled: true };
    return { kind: "failed", payload: reloaded, error };
  }
}

/** What to tell the writer after a mutation that did not go through. A
 * conflict names the reload; a lost answer says so; the rest name the cause.
 * `kept` is appended, e.g. " Draft kept." */
export function failureToast(
  outcome: Exclude<StoryMutationOutcome<object>, { readonly kind: "saved" }>,
  what: string,
  kept = ""
): string {
  if (outcome.kind === "conflict") return `${STORY_RELOADED_TOAST}${kept}`;
  if (outcome.kind === "unresolved") return `Could not check whether ${what} went through. Try again.${kept}`;
  return `${what} failed: ${errorMessage(outcome.error)}${kept}`;
}
