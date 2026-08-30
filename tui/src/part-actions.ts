import type { StoryNode } from "../../shared/types.js";

export type PartActionId =
  | "direct" | "continue" | "retake" | "retake-with-prompt" | "write" | "edit"
  | "copy" | "fact-from-selection" | "fact-from-here" | "fact-new-state" | "fact-end-here" | "fact-new"
  | "rewrite-selection" | "tag" | "prune"
  | "copy-line" | "paste-line";

export interface PartAction {
  id: PartActionId;
  name: string;
  description: string;
}

/** Local prompt/confirmation phases that must never freeze a virtual stream ID
 * as their eventual mutation target. */
export function partActionRequiresPersistedTarget(id: PartActionId): boolean {
  return id === "tag" || id === "prune" || id === "retake-with-prompt" || id === "rewrite-selection"
    || id === "copy-line" || id === "paste-line"
    || id === "fact-from-here" || id === "fact-new-state" || id === "fact-end-here";
}

/** "none": no selection. "text": a selection exists but is not one
 *  `resolveRewriteTarget` could ever accept (spans two parts, or is not a
 *  `:text` span). "rewritable": exactly what a rewrite can target. */
export type PartActionSelection = "none" | "text" | "rewritable";

/** OpenCode-style actions for one part, filtered to what it can actually do. */
export function partActions(
  node: StoryNode | undefined,
  isLeaf: boolean,
  selection: PartActionSelection = "none",
  hasCopiedLine = false
): PartAction[] {
  if (node === undefined) return [];
  const summary = node.role === "summary";
  const hasSelection = selection !== "none";
  const actions: PartAction[] = [
    { id: "continue", name: "Continue", description: isLeaf ? "extend this part" : "write a new part below" },
    { id: "direct", name: "Direct", description: "type what happens next here" }
  ];
  if (!summary) actions.push(
    { id: "retake", name: "Retake", description: "same prompt, fresh sibling take" },
    { id: "retake-with-prompt", name: "Retake with prompt", description: "edit the prompt for a sibling take" }
  );
  actions.push({ id: "write", name: "Write", description: "add a human take in the TUI" });
  if (!summary) actions.push({ id: "edit", name: "Edit", description: "change direction and prose inline" });
  actions.push({
    id: "copy",
    name: hasSelection ? "Copy selection" : "Copy",
    description: hasSelection ? "copy exactly the highlighted text" : "put this part on the clipboard"
  });
  if (hasSelection) actions.push({
    id: "fact-from-selection",
    name: "New fact from selection",
    description: "edit the text and optional tag"
  });
  // Chapter summaries are derived prose, not valid Fact State anchors. Keep
  // the story-wide door available; it does not attach metadata to this node.
  if (!summary) actions.push(
    { id: "fact-from-here", name: "Fact from here", description: "create a Fact scoped to this part" },
    { id: "fact-new-state", name: "New Fact state", description: "add a state at this part" },
    { id: "fact-end-here", name: "End Fact here", description: "end the effective Fact at this part" }
  );
  actions.push({ id: "fact-new", name: "New unscoped Fact", description: "create a story-wide Fact" });
  if (selection === "rewritable") actions.push({
    id: "rewrite-selection",
    name: "Rewrite selection",
    description: "regenerate the highlighted text"
  });
  if (!isLeaf) actions.push({
    id: "copy-line",
    name: "Copy story line below",
    description: "hold every part below this one, ready to paste elsewhere"
  });
  if (hasCopiedLine) actions.push({
    id: "paste-line",
    name: "Paste story line below",
    description: "attach the copied line here as the active continuation"
  });
  actions.push(
    { id: "tag", name: "Tag", description: "name the line this part ends" },
    { id: "prune", name: "Prune", description: "delete this take and everything under it" }
  );
  return actions;
}
