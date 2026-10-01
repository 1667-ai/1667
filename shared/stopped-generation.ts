import { isTimeoutClassFailure } from "./failure-envelope.js";
import type { CreateNodeRequest } from "./types.js";

/**
 * Where a stopped (or timed-out) generation's buffered text commits to —
 * shared by the TUI (`tui/src/generation-action.ts`) and the web UI
 * (`web/src/generation/settle.ts`), so both build the exact same
 * `CreateNodeRequest` shape from the same run-time facts (#409 step 5
 * review, item 7). `"append"` grows an existing leaf in place; `"take"`
 * opens a new part (`parentId: null` only for a brand new story's first
 * part).
 */
export type GenerationTarget =
  | { readonly mode: "append"; readonly appendTo: string; readonly expectedTextHash: string }
  | { readonly mode: "take"; readonly parentId: string | null };

/**
 * Builds the `createNode` body a stopped/timed-out generation's buffered
 * text commits with. `null` for whitespace-only (or empty) text — there is
 * nothing to commit, and the caller reloads instead of saving (matching
 * both the TUI's and the web's own "empty stop reloads, saves nothing"
 * behavior).
 *
 * An append keeps the buffer verbatim — it is already mid-sentence,
 * continuing the leaf's own existing prose at an exact byte boundary — with
 * an always-empty instruction (the `AppendNodeRequest` contract). A take
 * trims it, and records `instruction` exactly as given (the resolved
 * default direction when the writer typed nothing, never recomputed here).
 */
export function stoppedGenerationSaveBody(
  target: GenerationTarget,
  genId: string,
  instruction: string,
  text: string
): CreateNodeRequest | null {
  if (text.trim().length === 0) return null;
  if (target.mode === "append") {
    return { appendTo: target.appendTo, expectedTextHash: target.expectedTextHash, instruction: "", text, genId };
  }
  return { parentId: target.parentId, instruction, text: text.trim(), genId };
}

export type StoppedTextDisposition = "save" | "keep-unsaved" | "discard";

/** Duck-typed rather than `error instanceof ApiFailureError`: this module
 *  sits below `client/`, which is where that class lives, and importing it
 *  here would invert the dependency. Every `ApiFailureError` in this
 *  codebase carries a non-null `.failure` object (its constructor requires
 *  one); nothing else thrown across this boundary happens to shape-match. */
function isStructuredApiFailure(
  error: unknown
): error is { readonly failure: { readonly timeout?: string } } {
  if (typeof error !== "object" || error === null || !("failure" in error)) return false;
  const failure = (error as { readonly failure: unknown }).failure;
  return typeof failure === "object" && failure !== null;
}

/**
 * What a stopped/timed-out generation's buffered text should do once the
 * provider call itself has settled with an error — never called for a Stop
 * that instead raced a real result to completion (that path always adopts
 * the result; it never reaches this decision at all). Shared by the TUI and
 * the web so both agree on exactly which failures carry a clean-timeout
 * provenance stamp (`isTimeoutClassFailure` above), and so a later change to
 * that allowlist only ever has to happen in one place.
 *
 * - `"save"`: a clean timeout. The prose already streamed carries no server
 *   verdict, so it commits through the same idempotent-by-`genId` path a
 *   plain Stop uses.
 * - `"discard"`: a genuine provider/validation rejection. Committing this
 *   prose would durably save output the server refused.
 * - `"keep-unsaved"`: the error is not a structured API failure at all (the
 *   transport closed, the socket dropped) — there is no server verdict on
 *   the streamed prose, but a save attempt right now would fail immediately
 *   too. The web keeps this text visible in a "Not saved" card rather than
 *   attempting (and failing) a commit or silently losing it (decision 3: no
 *   auto-save after reconnect, but nothing is thrown away either). The TUI
 *   has no equivalent state and must keep treating this exactly like
 *   `"discard"` — see `tui/src/generation-action.ts`'s
 *   `isTimeoutClassApiFailure`, which only ever asks "is this `"save"`?".
 */
export function stoppedTextDisposition(error: unknown): StoppedTextDisposition {
  if (!isStructuredApiFailure(error)) return "keep-unsaved";
  return isTimeoutClassFailure(error.failure) ? "save" : "discard";
}
