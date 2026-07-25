import type { StoryNode } from "../../shared/types.js";

export type PartActionId =
  | "direct" | "continue" | "retake" | "retake-with-prompt" | "write" | "edit"
  | "copy" | "fact-from-selection" | "bookmark" | "prune";

export interface PartAction {
  id: PartActionId;
  name: string;
  description: string;
}

/** Local prompt/confirmation phases that must never freeze a virtual stream ID
 * as their eventual mutation target. */
export function partActionRequiresPersistedTarget(id: PartActionId): boolean {
  return id === "bookmark" || id === "prune" || id === "retake-with-prompt";
}

/** OpenCode-style actions for one part, filtered to what it can actually do. */
export function partActions(node: StoryNode | undefined, isLeaf: boolean, hasSelection = false): PartAction[] {
  if (node === undefined) return [];
  const summary = node.role === "summary";
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
  actions.push(
    { id: "bookmark", name: "Bookmark", description: "name the line this part ends" },
    { id: "prune", name: "Prune", description: "delete this take and everything under it" }
  );
  return actions;
}
