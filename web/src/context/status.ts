import type { RequestChapterProjection } from "../../../shared/request-projection.js";
import { dropReasonLabel, type FactRequestStatus } from "../../../shared/facts-model.js";
import { formatTokensEstimate } from "../../../shared/rail-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import type { RequestTokenEstimate } from "../../../shared/request-projection.js";

/** The next request's estimate for this story, or `null` while there is none. */
export function useRequestEstimate(storyId: string): RequestTokenEstimate | null {
  const { store } = useAppContext();
  return useStore(store, (state) => (state.context.projection?.storyId === storyId ? state.context.projection.estimate : null));
}

/** What the next request does with a Fact, as a Fact row says it. A Fact that
 * is off the line or ended already says so in its scope. */
export function factStatusLabel(status: FactRequestStatus): { readonly text: string; readonly kind: FactRequestStatus["kind"] } | null {
  switch (status.kind) {
    case "sent": return { text: "sent", kind: "sent" };
    case "not-matched": return { text: "not matched", kind: "not-matched" };
    case "unevaluated": return { text: "not checked", kind: "unevaluated" };
    case "dropped": return { text: `dropped · ${dropReasonLabel(status.reason)}`, kind: "dropped" };
    case "off-path":
    case "ended": return null;
  }
}

/** What a chapter's row says about the next request: whether it goes, and what a summary would change. */
export function chapterRequestNote(
  projection: RequestChapterProjection | undefined
): { readonly text: string; readonly tone: "" | "stale" | "saves" } | null {
  if (projection === undefined) return null;
  if (!projection.included) return { text: "Not in the next request", tone: "" };
  const size = formatTokensEstimate(projection.tokens);
  if (projection.summarized) {
    return projection.stale
      ? { text: `Sent as a stale summary · ${size}`, tone: "stale" }
      : { text: `Sent as its summary · ${size}`, tone: "" };
  }
  if (projection.savings > 0) {
    return { text: `Sent in full · ${size} · a summary frees ${formatTokensEstimate(projection.savings)}`, tone: "saves" };
  }
  return { text: `Sent in full · ${size}`, tone: "" };
}
