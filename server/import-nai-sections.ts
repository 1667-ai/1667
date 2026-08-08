import { ServiceError } from "./errors.js";
import { MAX_TOTAL_CHARS } from "./import-model.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { MAX_NOVELAI_RECORDS } from "./import-nai-msgpack-preflight.js";

export { MAX_NOVELAI_RECORDS };

export type SectionId = string | number;
export type NovelAiSection =
  | { readonly type: 0 }
  | { readonly type: 1; readonly text: string }
  | { readonly type: 2 };

interface PendingCreate {
  readonly id: SectionId;
  readonly section: NovelAiSection;
  readonly after: SectionId | 0 | undefined;
}

/** The document's live section state: every section, keyed by ID, and its
 * reading order. Both the top-level Document and each `history` node carry
 * one of these, as a base state plus a set of changes on top of a parent. */
export function readSections(
  raw: Map<unknown, unknown> | Record<string, unknown>
): Map<SectionId, NovelAiSection> {
  const entries = boundedEntries(raw, "sections");
  const sections = new Map<SectionId, NovelAiSection>();
  for (const [rawId, rawSection] of entries) {
    const id = sectionId(rawId, "sections map");
    if (sections.has(id)) {
      throw new ServiceError(400, "Duplicate section ID in sections map");
    }
    sections.set(id, readSection(rawSection));
  }
  return sections;
}

export function readOrder(
  raw: unknown[],
  sections: ReadonlyMap<SectionId, NovelAiSection>
): readonly SectionId[] {
  assertRecordCount(raw.length, "records");
  const ids: SectionId[] = [];
  const seen = new Set<SectionId>();
  for (const rawId of raw) {
    const id = sectionId(rawId, "document order");
    if (seen.has(id)) {
      throw new ServiceError(400, "Duplicate section ID in document order");
    }
    if (!sections.has(id)) {
      throw new ServiceError(400, "Order references an absent section");
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Apply one batch of create/update/remove steps — the shape the top-level
 * Document's `dirtySections` and every `history` node's `changes` share — to
 * `sections` (mutated in place) and return the resulting order. */
export function applyDirtySections(
  sections: Map<SectionId, NovelAiSection>,
  order: readonly SectionId[],
  raw: Map<unknown, unknown> | Record<string, unknown>
): readonly SectionId[] {
  const creates: PendingCreate[] = [];
  const removed = new Set<SectionId>();
  const orderedIds = new Set(order);
  for (const [rawId, rawStep] of boundedEntries(raw, "dirty sections")) {
    const id = sectionId(rawId, "dirty sections map");
    if (!isPlainRecord(rawStep)) {
      throw new ServiceError(400, "Corrupt dirty section step");
    }
    switch (rawStep.type) {
      case 0:
        creates.push(readCreate(sections, id, rawStep));
        break;
      case 1:
        applyUpdate(sections, orderedIds, id, rawStep);
        break;
      case 2:
        applyRemove(sections, orderedIds, removed, id, rawStep);
        break;
      default:
        throw new ServiceError(400, "Unknown dirty section step type");
    }
  }
  const resolvedOrder = resolveDirtyOrder(order, orderedIds, creates, removed);
  for (const create of creates) sections.set(create.id, create.section);
  return resolvedOrder;
}

function readCreate(
  sections: ReadonlyMap<SectionId, NovelAiSection>,
  id: SectionId,
  step: Record<string, unknown>
): PendingCreate {
  if (sections.has(id)) {
    throw new ServiceError(400, "Duplicate section ID in create step");
  }
  const section = readSection(step.section);
  const after = step.after === undefined
    ? undefined
    : step.after === 0
      ? 0
      : sectionId(step.after, "dirty create anchor");
  return { id, section, after };
}

function resolveDirtyOrder(
  order: readonly SectionId[],
  orderedIds: ReadonlySet<SectionId>,
  creates: PendingCreate[],
  removed: ReadonlySet<SectionId>
): readonly SectionId[] {
  const createIds = new Set(creates.map(({ id }) => id));
  const children = new Map<SectionId, PendingCreate[]>();
  const prepended: PendingCreate[] = [];
  const appended: PendingCreate[] = [];

  for (const create of creates) {
    if (create.after === undefined) {
      appended.push(create);
    } else if (create.after === 0) {
      prepended.push(create);
    } else {
      if (!orderedIds.has(create.after) && !createIds.has(create.after)) {
        throw new ServiceError(400, "Dirty create specifies an absent anchor");
      }
      const anchored = children.get(create.after) ?? [];
      anchored.push(create);
      children.set(create.after, anchored);
    }
  }

  const output: SectionId[] = [];
  const emitted = new Set<SectionId>();
  const emitTree = (root: PendingCreate): void => {
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (emitted.has(current.id)) {
        throw new ServiceError(400, "Dirty create anchors contain a cycle");
      }
      emitted.add(current.id);
      output.push(current.id);
      for (const child of children.get(current.id) ?? []) stack.push(child);
    }
  };
  const emitReverseForest = (roots: PendingCreate[]): void => {
    // Later inserts sit nearest their shared anchor.
    const stack = [...roots];
    while (stack.length > 0) emitTree(stack.pop()!);
  };

  emitReverseForest(prepended);
  for (const id of order) {
    if (!removed.has(id)) output.push(id);
    emitReverseForest(children.get(id) ?? []);
  }
  for (const root of appended) emitTree(root);
  if (emitted.size !== creates.length) {
    throw new ServiceError(400, "Dirty create anchors contain a cycle");
  }
  return output;
}

function applyUpdate(
  sections: Map<SectionId, NovelAiSection>,
  orderedIds: ReadonlySet<SectionId>,
  id: SectionId,
  step: Record<string, unknown>
): void {
  const existing = sections.get(id);
  if (existing === undefined || !orderedIds.has(id)) {
    throw new ServiceError(400, "Cannot update an absent section");
  }
  if (!isPlainRecord(step.diff)) {
    throw new ServiceError(400, "Corrupt section diff");
  }
  const diff = Object.hasOwn(step.diff, "diff") ? step.diff.diff : step.diff;
  if (!isPlainRecord(diff)) {
    throw new ServiceError(400, "Corrupt section diff");
  }
  if (Object.hasOwn(diff, "to")) {
    sections.set(id, readSection(diff.to));
    return;
  }
  if (existing.type !== 1 || !Array.isArray(diff.parts)) {
    throw new ServiceError(400, "Unrecognized section diff");
  }
  sections.set(id, { type: 1, text: applyTextDiff(existing.text, diff.parts) });
}

function applyRemove(
  sections: Map<SectionId, NovelAiSection>,
  orderedIds: ReadonlySet<SectionId>,
  removed: Set<SectionId>,
  id: SectionId,
  step: Record<string, unknown>
): void {
  if (!sections.has(id) || !orderedIds.has(id)) {
    throw new ServiceError(400, "Cannot remove an absent section");
  }
  if (step.previous !== undefined) readSection(step.previous);
  if (step.after !== undefined
    && step.after !== 0
    && !isSectionId(step.after)) {
    throw new ServiceError(400, "Malformed dirty remove anchor");
  }
  sections.delete(id);
  removed.add(id);
}

function applyTextDiff(text: string, rawParts: unknown[]): string {
  assertRecordCount(rawParts.length, "diff parts");
  if (text.length > MAX_TOTAL_CHARS) throw importTextTooLarge();

  const chunks: string[] = [];
  let sourceCursor = 0;
  let projectedLength = text.length;
  for (const rawPart of rawParts) {
    if (!isPlainRecord(rawPart)
      || !Number.isSafeInteger(rawPart.from)
      || (rawPart.from as number) < 0
      || typeof rawPart.delete !== "string"
      || typeof rawPart.insert !== "string") {
      throw new ServiceError(400, "Corrupt text diff part");
    }
    if (hasUnpairedSurrogate(rawPart.delete)
      || hasUnpairedSurrogate(rawPart.insert)) {
      throw new ServiceError(400, "Text diff contains invalid Unicode");
    }
    const editAt = sourceCursor + (rawPart.from as number);
    if (!Number.isSafeInteger(editAt)
      || editAt > text.length
      || !text.startsWith(rawPart.delete, editAt)) {
      throw new ServiceError(400, "Corrupt text diff bounds or deleted text");
    }
    projectedLength += rawPart.insert.length - rawPart.delete.length;
    if (!Number.isSafeInteger(projectedLength)
      || projectedLength < 0
      || projectedLength > MAX_TOTAL_CHARS) {
      throw importTextTooLarge();
    }
    chunks.push(text.slice(sourceCursor, editAt), rawPart.insert);
    sourceCursor = editAt + rawPart.delete.length;
  }
  chunks.push(text.slice(sourceCursor));
  const updated = chunks.join("");
  if (updated.length !== projectedLength || hasUnpairedSurrogate(updated)) {
    throw new ServiceError(400, "Corrupt text diff result");
  }
  return updated;
}

export function readSection(value: unknown): NovelAiSection {
  if (!isPlainRecord(value)
    || !Number.isInteger(value.type)
    || (value.type !== 0 && value.type !== 1 && value.type !== 2)) {
    throw new ServiceError(400, "Malformed or unsupported document section");
  }
  switch (value.type) {
    case 0:
      return { type: 0 };
    case 1:
      if (typeof value.text !== "string" || hasUnpairedSurrogate(value.text)) {
        throw new ServiceError(400, "Malformed text section");
      }
      return { type: 1, text: value.text };
    case 2:
      return { type: 2 };
  }
}

/** The line-ending and Unicode normalisation every section's prose takes on
 * its way into a story part, shared by the Document's active reading and by
 * a retry history branch's alternate reading. */
export function normalizeSectionText(text: string): string {
  return text.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function* boundedEntries(
  value: Map<unknown, unknown> | Record<string, unknown>,
  label: string
): Generator<[unknown, unknown]> {
  if (value instanceof Map) {
    assertRecordCount(value.size, label);
    yield* value.entries();
    return;
  }
  if (!isPlainRecord(value)) {
    throw new ServiceError(400, `Malformed ${label} map`);
  }
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    assertRecordCount(count, label);
    yield [key, value[key]];
  }
}

export function assertRecordCount(count: number, label: string): void {
  if (count > MAX_NOVELAI_RECORDS) {
    throw new ServiceError(
      400,
      `Document has more than ${MAX_NOVELAI_RECORDS} ${label} — too large to import`
    );
  }
}

export function sectionId(value: unknown, label: string): SectionId {
  if (!isSectionId(value)) {
    throw new ServiceError(400, `Malformed section ID in ${label}`);
  }
  return value;
}

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function importTextTooLarge(): ServiceError {
  return new ServiceError(400, "Story expands to more text than can be imported");
}
