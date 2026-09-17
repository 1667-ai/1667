/** Compare popover (⌥-click, D-05/D-23): two prose columns, the reader's
 * current line beside an off-path take's own line, with their shared tail
 * dimmed above. Rendered from `renderer-view.ts` like the log popover; opened
 * and kept in sync by `compareTake` (`renderer-compare-commands.ts`). */
import type { StoryPathNode, StoryPayload } from "../shared/types.js";
import { actionButton, el } from "./renderer-dom.js";
import type { RendererActions, RendererState } from "./renderer-model.js";

function compareRow(node: StoryPathNode | undefined): HTMLElement {
  if (node === undefined) return el("p", "compare-row empty", "No part here");
  return el("p", "compare-row", node.text);
}

export function renderComparePopover(story: StoryPayload, state: RendererState, actions: RendererActions): HTMLElement | null {
  const popover = state.popover;
  if (popover === null || popover.kind !== "compare") return null;
  const outer = el("div", "popover compare-popover");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Compare");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card compare-card");
  outer.append(card);

  if (popover.error !== null) {
    card.append(el("h2", "popover-title", "Compare"), el("p", "empty-copy", popover.error));
    return outer;
  }
  if (popover.read === null) {
    card.append(el("h2", "popover-title", "Compare"), el("p", "empty-copy", "Comparing…"));
    return outer;
  }

  const { forkIndex, parts, skipped } = popover.read;
  const partNumber = forkIndex + skipped + parts.length + 1;
  card.append(el("h2", "popover-title", `Compare · ¶ ${partNumber}`));

  const shared = forkIndex >= 0 ? story.path[forkIndex] : undefined;
  if (shared !== undefined) card.append(el("p", "compare-shared", shared.text));
  if (skipped > 0) {
    card.append(el("p", "compare-skipped", `⋯ ${skipped} earlier part${skipped === 1 ? "" : "s"} on each line`));
  }

  const yourStart = forkIndex + 1 + skipped;
  // One row per returned part: the take's side is capped at
  // MAX_TAKE_LINE_PARTS, and your side must not grow to the rest of a long
  // story after an early split.
  const rowCount = parts.length;
  const yours = el("div", "compare-column", el("h3", "", "Your line"));
  const theirs = el("div", "compare-column", el("h3", "", "This take"));
  for (let row = 0; row < rowCount; row += 1) {
    yours.append(compareRow(story.path[yourStart + row]));
    theirs.append(compareRow(parts[row]));
  }
  card.append(el("div", "compare-columns", yours, theirs));

  const footer = el("div", "compare-footer");
  footer.append(actionButton("compare-show", "Show this take", () => {
    actions.switchNode(popover.nodeId);
    actions.closePopover();
  }));
  card.append(footer);

  return outer;
}
