import type { ReasoningDisplayV2 } from "../../shared/settings-v2-types.js";
import type { StoryPart } from "./model.js";
import {
  streamForPart,
  streamHasSubstantiveReasoning,
  streamHasSubstantiveText,
  streamReasoningTrimmedText
} from "./stream-text.js";
import type { StreamView, ThoughtCacheEntry } from "./state.js";

/** Whether `part` has a thought to show at all — live, still streaming in, or
 *  already stored with the take. Independent of `state.reasoning`: every
 *  caller that gates thought UI on the mode checks that separately, so this
 *  answers one question only ("is there a thought"), not "should it render
 *  right now". */
export function partHasThought(
  part: Pick<StoryPart, "id" | "stub">,
  state: { stream: StreamView | null }
): boolean {
  const live = streamForPart(state.stream, part.id);
  if (live !== null) return streamHasSubstantiveReasoning(live);
  return part.stub.reasoning === true;
}

/** Effective fold state for one part's thought, folding `state.reasoning`'s
 *  ambient default together with any explicit `T` toggle recorded in
 *  `expandedThoughtIds`.
 *
 * `expandedThoughtIds` always means "this part's fold state was explicitly
 * flipped away from the mode's own default" — never "unfolded" outright — so
 * the same toggle mechanics `story-actions.ts` copies from `toggle-prompt`
 * (add on fold, delete on unfold — whichever the membership check below
 * needs) work under either mode without the action itself knowing which one
 * is active. `marker`'s default is folded (membership means unfolded);
 * `open`'s default is unfolded (membership means folded back down). */
export function thoughtUnfolded(
  state: { reasoning: ReasoningDisplayV2; expandedThoughtIds: ReadonlySet<string> },
  part: Pick<StoryPart, "id">
): boolean {
  const toggled = state.expandedThoughtIds.has(part.id);
  return state.reasoning === "open" ? !toggled : toggled;
}

/** Reasoning is arriving and no prose has landed yet — the one moment the
 *  gutter trades its ordinary `writing` line for `thinking`. Uses the same
 *  substantive check as `partHasThought`'s live branch, so the two can never
 *  disagree about whether a stream "has" a thought yet. */
export function streamThinkingOnly(stream: StreamView): boolean {
  return streamHasSubstantiveReasoning(stream) && !streamHasSubstantiveText(stream);
}

/** One take's thought, resolved to what is actually in hand right now — live
 *  stream text while it is still this part's own generation, otherwise
 *  whatever `state.thoughts` has cached for it (see `ensureThoughtLoaded`,
 *  reasoning-actions.ts). `tokenCount` is `null` exactly when there is
 *  nothing honest to print — never a fabricated number. */
export interface ResolvedThought {
  readonly text: string;
  readonly tokenCount: number | null;
  readonly status: "live" | "ready" | "loading" | "error";
}

export function resolvedThought(
  part: Pick<StoryPart, "id">,
  state: { stream: StreamView | null; thoughts: ReadonlyMap<string, ThoughtCacheEntry> }
): ResolvedThought {
  const live = streamForPart(state.stream, part.id);
  if (live !== null) {
    return {
      text: streamReasoningTrimmedText(live),
      tokenCount: live.reasoning !== undefined && live.reasoning.tokenCount > 0
        ? live.reasoning.tokenCount
        : null,
      status: "live"
    };
  }
  const cached = state.thoughts.get(part.id);
  if (cached === undefined || cached.status === "loading") {
    return { text: "", tokenCount: null, status: "loading" };
  }
  if (cached.status === "error") return { text: "", tokenCount: null, status: "error" };
  return {
    text: cached.record.text,
    tokenCount: cached.record.tokenCount > 0 ? cached.record.tokenCount : null,
    status: "ready"
  };
}

/** Every thought-gutter decision `gutterFor`, `gutterRowsFor` and
 *  `partPrefix`/`renderPartBody` (row-layout.ts, gutter.ts) need for one row,
 *  computed once in `layoutStoryRow` and threaded through rather than
 *  recomputed at each call site — the same reason `streaming`/`prepared` are
 *  computed once there and passed down.
 *
 * A discriminated union instead of independent booleans: `"hidden"` is the
 * one state with nothing to show — `state.reasoning === "off"`, or the part
 * has no thought and none is arriving — so every downstream reader narrows
 * on `kind` once and gets `resolved`/`hit` for free, instead of trusting a
 * doc comment that they are only readable together with `show`/`thinking`. */
export type ThoughtGutterContext =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "shown";
      /** True when the thought is folded (the default, or toggled back down
       *  in `open` mode) — false means the block sits unfolded above the
       *  part's prose. Replaces the four `show && !unfolded` call sites this
       *  union closes over. */
      readonly folded: boolean;
      readonly thinking: boolean;
      readonly hit: { readonly kind: "thought"; readonly index: number; readonly rowId: string };
      readonly resolved: ResolvedThought;
    };

export function thoughtGutterContext(
  part: StoryPart,
  rowIndex: number,
  state: {
    reasoning: ReasoningDisplayV2;
    expandedThoughtIds: ReadonlySet<string>;
    stream: StreamView | null;
    thoughts: ReadonlyMap<string, ThoughtCacheEntry>;
  },
  streaming: boolean,
  stream: StreamView | null
): ThoughtGutterContext {
  if (state.reasoning === "off") return { kind: "hidden" };
  const show = partHasThought(part, state);
  const thinking = streaming && stream !== null && streamThinkingOnly(stream);
  if (!show && !thinking) return { kind: "hidden" };
  return {
    kind: "shown",
    folded: !thoughtUnfolded(state, part),
    thinking,
    hit: { kind: "thought", index: rowIndex, rowId: part.id },
    resolved: resolvedThought(part, state)
  };
}
