import { Unpackr, addExtension } from "msgpackr/unpack";
import { ServiceError } from "./errors.js";
import {
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type ImportedPart
} from "./import-st.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import {
  assertBoundedNovelAiMessagePack,
  MAX_NOVELAI_RECORDS
} from "./import-nai-msgpack-preflight.js";

export { MAX_NOVELAI_RECORDS };

type SectionId = string | number;
type NovelAiSection = Record<string, unknown> & {
  type: 0 | 1 | 2;
  text?: string;
};

interface PendingCreate {
  readonly id: SectionId;
  readonly section: NovelAiSection;
  readonly after: SectionId | 0 | undefined;
}

interface DecodedDocument {
  sections?: Map<unknown, unknown> | Record<string, unknown>;
  order?: unknown[];
  dirtySections?: Map<unknown, unknown> | Record<string, unknown>;
}

interface OrderNode {
  readonly id: SectionId;
  next?: OrderNode;
}

// NovelAI's classes use msgpackr's structured extension form: a fixext marker
// followed by an ordinary encoded value. We only need the decoded data shape.
for (const type of [20, 30, 31, 40, 41, 42]) {
  addExtension({
    type,
    read(data: unknown) {
      return data;
    }
  });
}

const unpackr = new Unpackr({
  bundleStrings: true,
  moreTypes: true,
  structuredClone: false,
  mapsAsObjects: false
});

export function partsFromNovelAiDocument(base64: string): ImportedPart[] {
  const bytes = parseCanonicalBase64(base64);
  if (bytes.length < 3
    || bytes[0] !== 0xd4
    || bytes[1] !== 20
    || bytes[2] !== 0) {
    throw new ServiceError(400, "Malformed NovelAI Document envelope");
  }
  assertBoundedNovelAiMessagePack(bytes);

  let decoded: unknown;
  try {
    decoded = unpackr.unpack(bytes);
  } catch {
    throw new ServiceError(400, "Malformed MessagePack document");
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.order)) {
    throw new ServiceError(400, "Document missing sections or order");
  }

  const document = decoded as DecodedDocument;
  if (!(document.sections instanceof Map) && !isRecord(document.sections)) {
    throw new ServiceError(400, "Malformed sections map");
  }
  const sections = readSections(document.sections);
  let order = readOrder(decoded.order, sections);
  if (sections.size !== order.size) {
    throw new ServiceError(400, "Document contains an unordered section");
  }
  if (document.dirtySections !== undefined
    && !(document.dirtySections instanceof Map)
    && !isRecord(document.dirtySections)) {
    throw new ServiceError(400, "Malformed dirty sections map");
  }
  if (document.dirtySections !== undefined) {
    order = applyDirtySections(sections, order, document.dirtySections);
  }
  return importedParts(sections, order);
}

function parseCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new ServiceError(400, "Malformed base64 document");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64Code(value.charCodeAt(index))) {
      throw new ServiceError(400, "Malformed base64 document");
    }
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== "=") {
      throw new ServiceError(400, "Malformed base64 document");
    }
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new ServiceError(400, "Malformed base64 document");
  }
  return bytes;
}

function isBase64Code(code: number): boolean {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43
    || code === 47;
}

function readSections(
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

function readOrder(
  raw: unknown[],
  sections: ReadonlyMap<SectionId, NovelAiSection>
): SectionOrder {
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
  return new SectionOrder(ids);
}

function applyDirtySections(
  sections: Map<SectionId, NovelAiSection>,
  order: SectionOrder,
  raw: Map<unknown, unknown> | Record<string, unknown>
): SectionOrder {
  const creates: PendingCreate[] = [];
  const removed = new Set<SectionId>();
  for (const [rawId, rawStep] of boundedEntries(raw, "dirty sections")) {
    const id = sectionId(rawId, "dirty sections map");
    if (!isRecord(rawStep)) {
      throw new ServiceError(400, "Corrupt dirty section step");
    }
    switch (rawStep.type) {
      case 0:
        creates.push(readCreate(sections, id, rawStep));
        break;
      case 1:
        applyUpdate(sections, order, id, rawStep);
        break;
      case 2:
        applyRemove(sections, order, removed, id, rawStep);
        break;
      default:
        throw new ServiceError(400, "Unknown dirty section step type");
    }
  }
  const resolvedOrder = resolveDirtyOrder(order, creates, removed);
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
  order: SectionOrder,
  creates: PendingCreate[],
  removed: ReadonlySet<SectionId>
): SectionOrder {
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
      if (!order.has(create.after) && !createIds.has(create.after)) {
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
  for (const id of order.values()) {
    if (!removed.has(id)) output.push(id);
    emitReverseForest(children.get(id) ?? []);
  }
  for (const root of appended) emitTree(root);
  if (emitted.size !== creates.length) {
    throw new ServiceError(400, "Dirty create anchors contain a cycle");
  }
  return new SectionOrder(output);
}

function applyUpdate(
  sections: Map<SectionId, NovelAiSection>,
  order: SectionOrder,
  id: SectionId,
  step: Record<string, unknown>
): void {
  const existing = sections.get(id);
  if (existing === undefined || !order.has(id)) {
    throw new ServiceError(400, "Cannot update an absent section");
  }
  if (!isRecord(step.diff)) {
    throw new ServiceError(400, "Corrupt section diff");
  }
  const diff = Object.hasOwn(step.diff, "diff") ? step.diff.diff : step.diff;
  if (!isRecord(diff)) {
    throw new ServiceError(400, "Corrupt section diff");
  }
  if (Object.hasOwn(diff, "to")) {
    sections.set(id, readSection(diff.to));
    return;
  }
  if (existing.type !== 1 || !Array.isArray(diff.parts)) {
    throw new ServiceError(400, "Unrecognized section diff");
  }
  sections.set(id, { ...existing, text: applyTextDiff(existing.text!, diff.parts) });
}

function applyRemove(
  sections: Map<SectionId, NovelAiSection>,
  order: SectionOrder,
  removed: Set<SectionId>,
  id: SectionId,
  step: Record<string, unknown>
): void {
  if (!sections.has(id) || !order.has(id)) {
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
    if (!isRecord(rawPart)
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

function importedParts(
  sections: ReadonlyMap<SectionId, NovelAiSection>,
  order: SectionOrder
): ImportedPart[] {
  const parts: ImportedPart[] = [];
  const createdAt = new Date().toISOString();
  let totalChars = 0;
  for (const id of order.values()) {
    const section = sections.get(id);
    if (section === undefined) {
      throw new ServiceError(400, "Document order contains an absent section");
    }
    if (section.type !== 1) continue;
    const text = section.text!.normalize("NFC")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    if (text.trim().length === 0) continue;
    if (parts.length === MAX_PARTS) {
      throw new ServiceError(
        400,
        `Story has more than ${MAX_PARTS} sections — too large to import`
      );
    }
    totalChars += text.length;
    if (totalChars > MAX_TOTAL_CHARS) throw importTextTooLarge();
    parts.push({ instruction: "", text, createdAt });
  }
  if (parts.length === 0) {
    throw new ServiceError(400, "No importable prose found");
  }
  return parts;
}

function readSection(value: unknown): NovelAiSection {
  if (!isRecord(value)
    || !Number.isInteger(value.type)
    || (value.type !== 0 && value.type !== 1 && value.type !== 2)) {
    throw new ServiceError(400, "Malformed or unsupported document section");
  }
  if (value.type === 1
    && (typeof value.text !== "string" || hasUnpairedSurrogate(value.text))) {
    throw new ServiceError(400, "Malformed text section");
  }
  return value as NovelAiSection;
}

function boundedEntries(
  value: Map<unknown, unknown> | Record<string, unknown>,
  label: string
): [unknown, unknown][] {
  if (value instanceof Map) {
    assertRecordCount(value.size, label);
    return [...value.entries()];
  }
  if (!isRecord(value)) {
    throw new ServiceError(400, `Malformed ${label} map`);
  }
  const entries = Object.entries(value);
  assertRecordCount(entries.length, label);
  return entries;
}

function assertRecordCount(count: number, label: string): void {
  if (count > MAX_NOVELAI_RECORDS) {
    throw new ServiceError(
      400,
      `Document has more than ${MAX_NOVELAI_RECORDS} ${label} — too large to import`
    );
  }
}

function sectionId(value: unknown, label: string): SectionId {
  if (!isSectionId(value)) {
    throw new ServiceError(400, `Malformed section ID in ${label}`);
  }
  return value;
}

function isSectionId(value: unknown): value is SectionId {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function importTextTooLarge(): ServiceError {
  return new ServiceError(400, "Story expands to more text than can be imported");
}

class SectionOrder {
  readonly nodes = new Map<SectionId, OrderNode>();
  head?: OrderNode;
  tail?: OrderNode;

  constructor(ids: SectionId[]) {
    for (const id of ids) {
      if (this.nodes.has(id)) {
        throw new ServiceError(400, "Duplicate section ID in document order");
      }
      const node: OrderNode = { id };
      if (this.tail) this.tail.next = node;
      else this.head = node;
      this.tail = node;
      this.nodes.set(id, node);
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  has(id: SectionId): boolean {
    return this.nodes.has(id);
  }

  *values(): IterableIterator<SectionId> {
    let node = this.head;
    while (node) {
      yield node.id;
      node = node.next;
    }
  }
}
