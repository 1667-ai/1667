import { Packr } from "msgpackr";

/** Synthetic fixture encoded with NovelAI's exact msgpackr extension 20 form. */
export const STATIC_SYNTHETIC_V2_BASE64 =
  "1BQA1HJAldZiAAAANsEIwQXBB8ENwQSCzGXUckGSwQTBBAHBGsxmQQHBGpLMZcxm1HJCk8EEwQfBBQAAkIABoNlxc2VjdGlvbnNvcmRlcmhpc3RvcnlkaXJ0eVNlY3Rpb25zc3RlcHR5cGV0ZXh0U3ludGhldGljIGNoYXB0ZXIgMSBwcm9zZS5TeW50aGV0aWMgY2hhcHRlciAyIHByb3NlLnJvb3RjdXJyZW50bm9kZXM=";

class SyntheticNovelAiDocument {
  constructor(readonly value: Record<string, unknown>) {}
}

class SyntheticNovelAiHistory {
  constructor(readonly value: Record<string, unknown>) {}
}

class SyntheticNovelAiHistoryNode {
  constructor(readonly value: Record<string, unknown>) {}
}

/** One entry of a NovelAI `history` tree — the retry/checkpoint tree behind
 * every swipe. `parent` is absent for the root; `changes` takes the exact
 * step shape `dirtySections` uses (see `SyntheticNovelAiSectionDiff` for an
 * update step; a create step is a plain `{ type: 0, section, after }`). */
export interface SyntheticHistoryNodeSpec {
  readonly parent?: string | number;
  readonly changes?: Map<string | number, unknown> | Record<string, unknown>;
  readonly date?: string | Date;
}

export interface SyntheticHistorySpec {
  readonly root: string | number;
  readonly current: string | number;
  readonly nodes: Map<string | number, SyntheticHistoryNodeSpec>;
}

export class SyntheticNovelAiSectionDiff {
  constructor(readonly value: unknown) {}
}

export class SyntheticNovelAiTextDiff {
  constructor(readonly value: Record<string, unknown>) {}
}

const scalarPackr = new Packr({
  bundleStrings: false,
  moreTypes: true,
  structuredClone: false,
  useRecords: false
});

class NovelAiFixtureEncoder {
  private readonly records = new Map<string, number>();

  encode(value: unknown): Buffer {
    if (value instanceof SyntheticNovelAiDocument) return this.extension(20, value.value);
    if (value instanceof SyntheticNovelAiHistory) return this.extension(30, value.value);
    if (value instanceof SyntheticNovelAiHistoryNode) return this.extension(31, value.value);
    if (value instanceof SyntheticNovelAiSectionDiff) return this.extension(40, value.value);
    if (value instanceof SyntheticNovelAiTextDiff) return this.extension(41, value.value);
    if (Array.isArray(value)) {
      return Buffer.concat([
        containerHeader(value.length, false),
        ...value.map((entry) => this.encode(entry))
      ]);
    }
    if (value instanceof Map) return this.map(value);
    if (isPlainObject(value)) return this.record(value);
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 0x100000000) {
      return encodeSafeUint(value);
    }
    return Buffer.from(scalarPackr.pack(value));
  }

  private extension(type: number, value: unknown): Buffer {
    return Buffer.concat([Buffer.from([0xd4, type, 0]), this.encode(value)]);
  }

  private map(value: ReadonlyMap<unknown, unknown>): Buffer {
    const entries: Buffer[] = [];
    for (const [key, entryValue] of value) {
      entries.push(this.encode(key), this.encode(entryValue));
    }
    return Buffer.concat([containerHeader(value.size, true), ...entries]);
  }

  private record(value: Record<string, unknown>): Buffer {
    const entries = Object.entries(value);
    const shape = JSON.stringify(entries.map(([key]) => key));
    let id = this.records.get(shape);
    const encoded: Buffer[] = [];
    if (id === undefined) {
      id = this.records.size;
      if (id >= 32) throw new Error("NovelAI fixture has too many record shapes");
      this.records.set(shape, id);
      encoded.push(
        Buffer.from([0xd4, 0x72, 0x40 + id]),
        this.encode(entries.map(([key]) => key))
      );
    } else {
      encoded.push(Buffer.from([0x40 + id]));
    }
    for (const [, entryValue] of entries) encoded.push(this.encode(entryValue));
    return Buffer.concat(encoded);
  }
}

/** msgpackr's own record-repeat reference reuses positive-fixint bytes
 * 0x40-0x7f: once any record shape is defined in the stream, byte 0x40
 * alone means "read record 0" everywhere, not the literal integer 64. Real
 * msgpackr's Packr dodges this by never emitting a bare fixint for 64-127
 * once records are active (see its `useRecords`/`_writeStruct` check); this
 * fixture encoder needs the same rule for every integer, since a section ID
 * or a history node ID routinely lands in that range. 0-63 stays a single
 * byte, matching the token range the decoder never treats as a record ref. */
function encodeSafeUint(value: number): Buffer {
  if (value < 0x40) return Buffer.from([value]);
  if (value <= 0xff) return Buffer.from([0xcc, value]);
  if (value <= 0xffff) return Buffer.from([0xcd, value >> 8, value & 0xff]);
  const header = Buffer.alloc(5);
  header[0] = 0xce;
  header.writeUInt32BE(value, 1);
  return header;
}

function containerHeader(size: number, map: boolean): Buffer {
  if (size < 16) return Buffer.from([(map ? 0x80 : 0x90) | size]);
  if (size <= 0xffff) {
    return Buffer.from([map ? 0xde : 0xdc, size >> 8, size & 0xff]);
  }
  const header = Buffer.alloc(5);
  header[0] = map ? 0xdf : 0xdd;
  header.writeUInt32BE(size, 1);
  return header;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function makeSyntheticNovelAiV2Base64(
  sections: Map<string | number, unknown> | Record<string, unknown>,
  order: (string | number)[],
  dirtySections?: Map<string | number, unknown> | Record<string, unknown>,
  history?: SyntheticHistorySpec
): string {
  return new NovelAiFixtureEncoder().encode(new SyntheticNovelAiDocument({
    sections,
    order,
    history: history === undefined
      ? new SyntheticNovelAiHistory({ root: 0, current: 0, nodes: [] })
      : new SyntheticNovelAiHistory({
        root: history.root,
        current: history.current,
        nodes: new Map(Array.from(history.nodes, ([id, node]) => [
          id,
          new SyntheticNovelAiHistoryNode({
            parent: node.parent,
            changes: node.changes ?? new Map(),
            date: node.date ?? "2024-01-01T00:00:00.000Z"
          })
        ]))
      }),
    dirtySections: dirtySections ?? new Map(),
    step: 1
  })).toString("base64");
}
