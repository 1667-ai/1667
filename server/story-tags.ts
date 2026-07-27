import { isTagStatus, type Story } from "../shared/types.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { requireNode } from "./story-nodes.js";

const TAG_COLORS = ["#4b45c9", "#2f9e6b", "#c98a2b", "#c53b30", "#8a4bc9", "#3b7bc9"] as const;
const SUMMARY_COLOR = "#0e9c8a";

export function putStoryTag(story: Story, nodeId: string, nameValue: string, statusValue: string): void {
  const node = requireNode(story, nodeId);
  const existing = story.tags.find((tag) => tag.nodeId === nodeId);
  // Logical line end, not structural leafness: inactive children may hang below
  // a named line after a summary or branch switch.
  if (existing === undefined && node.activeChildId !== null) {
    throw new ServiceError(400, "Only the end of a line can be tagged");
  }
  const name = nameValue.trim();
  const nameLength = unicodeScalarLength(name, 80);
  if (nameLength < 1 || nameLength > 80 || name !== nameValue) {
    throw new ServiceError(400, "Tag name must be trimmed and contain 1–80 characters");
  }
  if (!isTagStatus(statusValue)) throw new ServiceError(400, "Tag status is invalid");
  if (statusValue === "Canon") {
    // Canon is a singleton, so naming a new one displaces the old. It becomes
    // Alt rather than unset: the writer named that line and kept it, and it is
    // now precisely an alternative. Dropping it to "" would render it dim and
    // glyph-identical to an untagged leaf, losing the distinction silently.
    for (const tag of story.tags) {
      if (tag.nodeId !== nodeId && tag.status === "Canon") tag.status = "Alt";
    }
  }
  if (existing !== undefined) {
    existing.name = name;
    existing.status = statusValue;
    return;
  }
  story.tags.push({
    nodeId,
    name,
    status: statusValue,
    color: statusValue === "Summary"
      ? SUMMARY_COLOR
      : TAG_COLORS[story.tags.length % TAG_COLORS.length]!,
    createdAt: new Date().toISOString()
  });
}

export function removeStoryTag(story: Story, nodeId: string): void {
  const index = story.tags.findIndex((tag) => tag.nodeId === nodeId);
  if (index === -1) throw new ServiceError(404, `Tag not found: ${nodeId}`);
  story.tags.splice(index, 1);
}
