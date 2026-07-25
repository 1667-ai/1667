import { isBookmarkLabel, type Story } from "../shared/types.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import { requireNode } from "./story-nodes.js";

const BOOKMARK_COLORS = ["#4b45c9", "#2f9e6b", "#c98a2b", "#c53b30", "#8a4bc9", "#3b7bc9"] as const;
const SUMMARY_COLOR = "#0e9c8a";

export function putStoryBookmark(story: Story, nodeId: string, nameValue: string, labelValue: string): void {
  const node = requireNode(story, nodeId);
  const existing = story.bookmarks.find((bookmark) => bookmark.nodeId === nodeId);
  // Logical line end, not structural leafness: inactive children may hang below
  // a named line after a summary or branch switch.
  if (existing === undefined && node.activeChildId !== null) {
    throw new ServiceError(400, "Only the end of a line can be bookmarked");
  }
  const name = nameValue.trim();
  const nameLength = unicodeScalarLength(name, 80);
  if (nameLength < 1 || nameLength > 80 || name !== nameValue) {
    throw new ServiceError(400, "Bookmark name must be trimmed and contain 1–80 characters");
  }
  if (!isBookmarkLabel(labelValue)) throw new ServiceError(400, "Bookmark label is invalid");
  if (labelValue === "Canon") {
    for (const bookmark of story.bookmarks) {
      if (bookmark.nodeId !== nodeId && bookmark.label === "Canon") bookmark.label = "";
    }
  }
  if (existing !== undefined) {
    existing.name = name;
    existing.label = labelValue;
    return;
  }
  story.bookmarks.push({
    nodeId,
    name,
    label: labelValue,
    color: labelValue === "Summary"
      ? SUMMARY_COLOR
      : BOOKMARK_COLORS[story.bookmarks.length % BOOKMARK_COLORS.length]!,
    createdAt: new Date().toISOString()
  });
}

export function removeStoryBookmark(story: Story, nodeId: string): void {
  const index = story.bookmarks.findIndex((bookmark) => bookmark.nodeId === nodeId);
  if (index === -1) throw new ServiceError(404, `Bookmark not found: ${nodeId}`);
  story.bookmarks.splice(index, 1);
}
