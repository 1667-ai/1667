import type { ChapterBreak, CoveredExtent, StoryNode } from "../shared/types.js";
import {
  StoryFormatError,
  arrayValue,
  optionalString,
  parseRestoredAttribution,
  recordValue,
  stringField,
  timestampField
} from "./story-format-facts.js";

export interface StoredChapterNodeFields {
  chapterBreakId?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
}

export function parseStoredChapterNode(
  node: Record<string, unknown>,
  label: string
): StoredChapterNodeFields {
  const chapterBreakId = optionalString(node.chapterBreakId, `${label}.chapterBreakId`);
  const coveredExtent = node.coveredExtent === undefined
    ? undefined
    : parseExtent(node.coveredExtent, `${label}.coveredExtent`);
  const madeAt = node.madeAt === undefined ? undefined : parseChapterTimestamp(node.madeAt, `${label}.madeAt`);
  const editedByUser = optionalTrue(node.editedByUser, `${label}.editedByUser`);
  const count = [chapterBreakId, coveredExtent, madeAt].filter((value) => value !== undefined).length;
  if (count !== 0 && count !== 3) {
    throw new StoryFormatError(`${label} chapter summary fields must be stored together`);
  }
  if (editedByUser !== undefined && count === 0) {
    throw new StoryFormatError(`${label}.editedByUser requires chapter summary fields`);
  }
  return {
    ...(chapterBreakId === undefined ? {} : { chapterBreakId }),
    ...(coveredExtent === undefined ? {} : { coveredExtent }),
    ...(madeAt === undefined ? {} : { madeAt }),
    ...(editedByUser === undefined ? {} : { editedByUser })
  };
}

export function parseChapterBreaks(value: unknown): ChapterBreak[] {
  const ids = new Set<string>();
  const parents = new Set<string>();
  return arrayValue(value, "chapterBreaks").map((entry, index) => {
    const label = `chapterBreaks[${index}]`;
    const chapterBreak = parseChapterBreak(entry, label);
    if (ids.has(chapterBreak.id)) throw new StoryFormatError(`Duplicate chapter break id: ${chapterBreak.id}`);
    if (parents.has(chapterBreak.parentPartId)) {
      throw new StoryFormatError(`Duplicate chapter break parent: ${chapterBreak.parentPartId}`);
    }
    ids.add(chapterBreak.id);
    parents.add(chapterBreak.parentPartId);
    return chapterBreak;
  });
}

export function parseChapterBreak(value: unknown, label: string): ChapterBreak {
  const item = recordValue(value, label);
  return {
    id: stringField(item, "id"),
    parentPartId: stringField(item, "parentPartId"),
    title: stringField(item, "title"),
    createdAt: timestampField(item, "createdAt", label)
  };
}

export function parseRestoredChapterBreak(value: unknown, label: string): ChapterBreak {
  const chapterBreak = parseChapterBreak(value, label);
  requireNonEmpty(chapterBreak.id, `${label}.id`);
  requireNonEmpty(chapterBreak.parentPartId, `${label}.parentPartId`);
  return chapterBreak;
}

export function parseRestoredChapterSummary(value: unknown, label: string): StoryNode {
  const node = recordValue(value, label);
  const parentId = node.parentId === null ? null : optionalString(node.parentId, `${label}.parentId`);
  if (parentId === undefined) throw new StoryFormatError(`${label}.parentId must be a string or null`);
  if (node.activeChildId !== null) throw new StoryFormatError(`${label}.activeChildId must be null`);
  const attribution = parseRestoredAttribution(node.attribution, `${label}.attribution`);
  const updatedAt = node.updatedAt === undefined ? undefined : timestampField(node, "updatedAt", label);
  const human = optionalTrue(node.human, `${label}.human`);
  const genId = optionalString(node.genId, `${label}.genId`);
  const extent = parseExtent(node.coveredExtent, `${label}.coveredExtent`);
  requireNonEmpty(extent.fromPartId, `${label}.coveredExtent.fromPartId`);
  requireNonEmpty(extent.toPartId, `${label}.coveredExtent.toPartId`);
  return {
    id: nonEmptyStringField(node, "id", `${label}.id`),
    parentId,
    instruction: stringField(node, "instruction"),
    text: stringField(node, "text"),
    model: stringField(node, "model"),
    createdAt: timestampField(node, "createdAt", label),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(attribution === undefined ? {} : { attribution }),
    ...(human === undefined ? {} : { human }),
    ...(genId === undefined ? {} : { genId }),
    role: node.role === "summary" ? "summary" : undefined,
    chapterBreakId: nonEmptyStringField(node, "chapterBreakId", `${label}.chapterBreakId`),
    coveredExtent: extent,
    madeAt: parseChapterTimestamp(node.madeAt, `${label}.madeAt`),
    ...(node.editedByUser === true ? { editedByUser: true as const } : {}),
    activeChildId: null
  };
}

export function validateChapterRecords(
  chapterBreaks: readonly ChapterBreak[],
  nodes: ReadonlyArray<{
    id: string;
    parentId: string | null;
    activeChildId: string | null;
    role?: "summary";
    chapterBreakId?: string;
    coveredExtent?: CoveredExtent;
    madeAt?: string;
  }>
): void {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const breaksById = new Map(chapterBreaks.map((chapterBreak) => [chapterBreak.id, chapterBreak] as const));
  const summaryBreakIds = new Set<string>();
  for (const chapterBreak of chapterBreaks) {
    const parent = byId.get(chapterBreak.parentPartId);
    if (parent === undefined || parent.chapterBreakId !== undefined) {
      throw new StoryFormatError(`Chapter break ${chapterBreak.id} references an unknown parent part`);
    }
    if (byId.has(chapterBreak.id)) throw new StoryFormatError(`Chapter break id is already used: ${chapterBreak.id}`);
  }
  for (const node of nodes) {
    if (node.chapterBreakId === undefined) continue;
    if (node.role !== "summary" || node.parentId === null || node.activeChildId !== null) {
      throw new StoryFormatError(`Node ${node.id} has invalid chapter summary placement`);
    }
    const chapterBreak = breaksById.get(node.chapterBreakId);
    if (chapterBreak === undefined || chapterBreak.parentPartId !== node.parentId) {
      throw new StoryFormatError(`Node ${node.id} references an invalid chapter break`);
    }
    if (node.coveredExtent === undefined || node.madeAt === undefined) {
      throw new StoryFormatError(`Node ${node.id} is missing chapter summary metadata`);
    }
    const from = byId.get(node.coveredExtent.fromPartId);
    const to = byId.get(node.coveredExtent.toPartId);
    if (
      from === undefined
      || to === undefined
      || from.chapterBreakId !== undefined
      || to.chapterBreakId !== undefined
      || node.coveredExtent.toPartId !== node.parentId
    ) {
      throw new StoryFormatError(`Node ${node.id} covers an unknown part`);
    }
    if (summaryBreakIds.has(node.chapterBreakId)) {
      throw new StoryFormatError(`Duplicate summary for chapter break: ${node.chapterBreakId}`);
    }
    summaryBreakIds.add(node.chapterBreakId);
  }
  for (const node of nodes) {
    if (node.activeChildId !== null && byId.get(node.activeChildId)?.chapterBreakId !== undefined) {
      throw new StoryFormatError(`Node ${node.id}.activeChildId must not reference a chapter summary`);
    }
    if (node.parentId !== null && byId.get(node.parentId)?.chapterBreakId !== undefined) {
      throw new StoryFormatError(`Chapter summary ${node.parentId} must be a dead end`);
    }
  }
}

export function parseExtent(value: unknown, label: string): CoveredExtent {
  const extent = recordValue(value, label);
  return {
    fromPartId: stringField(extent, "fromPartId"),
    toPartId: stringField(extent, "toPartId")
  };
}

function optionalTrue(value: unknown, label: string): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) throw new StoryFormatError(`${label} must be true or absent`);
  return true;
}

export function parseChapterTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new StoryFormatError(`${label} must be a valid timestamp`);
  }
  return value;
}

function nonEmptyStringField(value: Record<string, unknown>, field: string, label: string): string {
  const result = stringField(value, field);
  requireNonEmpty(result, label);
  return result;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new StoryFormatError(`${label} must not be empty`);
}
