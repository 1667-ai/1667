import { createHash, randomUUID } from "node:crypto";
import type { ChapterBreak, Story, StoryNode } from "../shared/types.js";
import { canonicalJson } from "./canonical-json.js";
import { ServiceError as HttpError } from "./errors.js";
import {
  parseRestoredChapterBreak,
  parseRestoredChapterSummary
} from "./story-format-chapters.js";
import { arrayValue, recordValue, StoryFormatError } from "./story-format-facts.js";
import { requireNode } from "./story-nodes.js";

export interface RemovedChapterBreak {
  break: ChapterBreak;
  summaries: StoryNode[];
}

export function chapterBreakRemovalFingerprint(
  removed: RemovedChapterBreak
): string {
  return createHash("sha256")
    .update("chapter-break-removal-v1\0", "utf8")
    .update(canonicalJson(removed), "utf8")
    .digest("hex");
}

export function createChapterBreak(
  story: Story,
  parentPartId: string,
  title = "",
  id: string = randomUUID()
): ChapterBreak {
  const parent = requireNode(story, parentPartId);
  if (parent.chapterBreakId !== undefined) throw new HttpError(400, "A chapter summary cannot anchor a chapter break");
  if (story.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === parentPartId)) {
    throw new HttpError(409, "This seam already has a chapter break");
  }
  const chapterBreak = { id, parentPartId, title, createdAt: new Date().toISOString() };
  story.chapterBreaks.push(chapterBreak);
  return chapterBreak;
}

export function renameChapterBreak(story: Story, breakId: string, title: string): ChapterBreak {
  const chapterBreak = requireChapterBreak(story, breakId);
  chapterBreak.title = title;
  return chapterBreak;
}

/** Chapter one has no opening break, so its name is stored on the story. An
 * empty name is an absent one: the chapter then reads as the story itself,
 * which is what it did before it could be named at all. */
export function renameFirstChapter(story: Story, title: string): void {
  if (title === "") delete story.firstChapterTitle;
  else story.firstChapterTitle = title;
}

export function removeChapterBreak(story: Story, breakId: string): RemovedChapterBreak {
  const index = story.chapterBreaks.findIndex((chapterBreak) => chapterBreak.id === breakId);
  if (index === -1) throw new HttpError(404, `Chapter break not found: ${breakId}`);
  const chapterBreak = story.chapterBreaks[index]!;
  const summaries = story.nodes.filter((node) => node.chapterBreakId === breakId).map(cloneNode);
  const summaryIds = new Set(summaries.map((node) => node.id));
  story.chapterBreaks.splice(index, 1);
  story.nodes = story.nodes.filter((node) => !summaryIds.has(node.id));
  story.tags = story.tags.filter((tag) => !summaryIds.has(tag.nodeId));
  story.recentNodeIds = story.recentNodeIds.filter((nodeId) => !summaryIds.has(nodeId));
  return { break: { ...chapterBreak }, summaries };
}

export function restoreChapterBreak(
  story: Story,
  routeBreakId: string,
  removed: RemovedChapterBreak
): void {
  const chapterBreak = parseRestoredChapterBreak(removed.break, "break");
  if (chapterBreak.id !== routeBreakId) throw new HttpError(400, "Restored chapter break id does not match the route");
  const parent = requireNode(story, chapterBreak.parentPartId);
  if (parent.chapterBreakId !== undefined) throw new HttpError(400, "A chapter summary cannot anchor a chapter break");
  if (
    story.chapterBreaks.some((candidate) => candidate.id === chapterBreak.id)
    || story.nodes.some((node) => node.id === chapterBreak.id)
  ) throw new HttpError(409, `Chapter break id is already used: ${chapterBreak.id}`);
  if (story.chapterBreaks.some((candidate) => candidate.parentPartId === chapterBreak.parentPartId)) {
    throw new HttpError(409, "This seam already has a chapter break");
  }
  const taken = new Set(story.nodes.map((node) => node.id));
  const summaries = removed.summaries.map((value) => parseSummary(value, chapterBreak));
  if (summaries.length > 1) throw new HttpError(400, "Only one summary may be restored for a chapter break");
  for (const summary of summaries) {
    if (taken.has(summary.id)) throw new HttpError(409, `Node id is already used: ${summary.id}`);
    taken.add(summary.id);
    const summaryParent = requireNode(story, summary.parentId!);
    if (summaryParent.chapterBreakId !== undefined) throw new HttpError(400, "A chapter summary must follow a prose part");
    for (const partId of [summary.coveredExtent!.fromPartId, summary.coveredExtent!.toPartId]) {
      if (requireNode(story, partId).chapterBreakId !== undefined) {
        throw new HttpError(400, "A chapter summary extent must reference prose parts");
      }
    }
  }
  story.chapterBreaks.push(chapterBreak);
  story.nodes.push(...summaries);
}

export function requireChapterBreak(story: Story, breakId: string): ChapterBreak {
  const chapterBreak = story.chapterBreaks.find((candidate) => candidate.id === breakId);
  if (chapterBreak === undefined) throw new HttpError(404, `Chapter break not found: ${breakId}`);
  return chapterBreak;
}

export function parseRemovedChapterBreak(value: unknown): RemovedChapterBreak {
  try {
    const body = recordValue(value, "restore body");
    return {
      break: parseRestoredChapterBreak(body.break, "break"),
      summaries: arrayValue(body.summaries, "summaries")
        .map((summary, index) => parseRestoredChapterSummary(summary, `summaries[${index}]`))
    };
  } catch (error) {
    if (error instanceof StoryFormatError) throw new HttpError(400, error.message);
    throw error;
  }
}

function parseSummary(value: StoryNode, chapterBreak: ChapterBreak): StoryNode {
  if (
    value.role !== "summary"
    || value.chapterBreakId !== chapterBreak.id
    || value.parentId !== chapterBreak.parentPartId
    || value.activeChildId !== null
    || value.coveredExtent === undefined
    || value.coveredExtent.toPartId !== value.parentId
    || value.madeAt === undefined
  ) throw new HttpError(400, `Invalid restored chapter summary: ${value.id}`);
  return cloneNode(value);
}

function cloneNode(node: StoryNode): StoryNode {
  return {
    ...node,
    ...(node.coveredExtent === undefined ? {} : { coveredExtent: { ...node.coveredExtent } }),
    ...(node.attribution == null ? {} : {
      attribution: { ...node.attribution, ranges: node.attribution.ranges.map((range) => ({ ...range })) }
    })
  };
}
