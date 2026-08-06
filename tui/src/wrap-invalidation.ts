import type { StoryNode, StoryPayload, TextRange } from "../../shared/types.js";
import { wrapInput } from "./story-wrap-build.js";
import type { ProseStyle, WrapCache } from "./wrap.js";

/** The one wrap-cache invalidation boundary. Every authoritative payload
 * adoption routes through here (story-adoption.ts); no action clears the
 * cache on its own. Adopting the same story keeps every part whose wrap
 * input is unchanged, drops exactly the cached parts whose prose changed,
 * and drops cached parts the new path no longer carries. Only a different
 * story clears the whole cache, and that path already paints an honest
 * loading frame instead of stale prose (interactive-frame-runtime.ts). */
export function reconcileWrapCache(
  cache: WrapCache<ProseStyle>,
  previous: StoryPayload,
  next: StoryPayload
): void {
  if (previous.id !== next.id) return void cache.invalidate();
  const settled = new Map(previous.path.map((node) => [node.id, node]));
  const stale = new Set(cache.partIds());
  for (const node of next.path) {
    const before = settled.get(node.id);
    if (before === undefined || !sameWrapProse(before, node)) continue;
    // The next frame identifies this part by its new payload node object.
    // Retarget the entries this equality proof covers; entries primed under
    // another extent (a live stream's projection) keep their old identity
    // and miss on their own.
    cache.rebind(node.id, node, node.text.length);
    stale.delete(node.id);
  }
  // What remains is cached prose no current part vouches for: parts whose
  // wrap input changed, parts that left the path, and never-settled stream
  // targets. Dropping per part id is what keeps invalidation exact instead
  // of a hidden full clear.
  for (const partId of stale) cache.invalidate(partId);
}

/** Equal over exactly the fields wrapInput() feeds into a wrap plan. Any
 * field outside that projection cannot change wrapped lines, so it cannot
 * make a cache entry stale. */
function sameWrapProse(before: StoryNode, after: StoryNode): boolean {
  const left = wrapInput(before);
  const right = wrapInput(after);
  return left.node.text === right.node.text
    && left.isSummary === right.isSummary
    && sameRanges(left.humanSpans, right.humanSpans)
    && sameRanges(left.rewrittenSpans, right.rewrittenSpans);
}

function sameRanges(left: readonly TextRange[], right: readonly TextRange[]): boolean {
  return left.length === right.length && left.every((range, index) =>
    range.start === right[index]!.start && range.end === right[index]!.end);
}
