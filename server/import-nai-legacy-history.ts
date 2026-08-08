import type { ImportedPart } from "./import-model.js";
import { countNoun } from "../shared/fidelity.js";
import { isPlainRecord, normalizeSectionText } from "./import-nai-sections.js";
import { MAX_NOVELAI_RECORDS } from "./import-nai-msgpack-preflight.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";

export interface NovelAiLegacyHistoryAlternates {
  /** New parts, each carrying `parentIndex` and `active: false`. `parentIndex`
   *  is relative to the combined array: the active parts the caller already
   *  built, followed by these, in this order. */
  readonly parts: readonly ImportedPart[];
  readonly fidelity: readonly string[];
}

interface LegacyBlock {
  readonly text: string;
  /** `null` when the block's own origin cannot be told apart from an edit —
   *  too ambiguous to trust as a pure append. */
  readonly origin: string | null;
  readonly nextBlock: readonly number[];
  /** Absent for the story's root block. */
  readonly prevBlock: number | undefined;
  readonly removed: boolean;
  /** Absolute insertion position. `null` means that append status is not
   *  proven, so the branch is not safe to import. */
  readonly startIndex: number | null;
}

/** Turn a legacy NovelAI V1 `.story` file's `datablocks` — the retry graph
 * behind every swipe, undo, and edit in the old story editor — into 1667
 * alternate takes.
 *
 * `datablocks` is an array of blocks; `currentBlock` names the index of the
 * active leaf. Each block's `prevBlock` walks back toward the root, and each
 * block's `nextBlock` lists its children — more than one child recorded a
 * retry at that point. The chain from `currentBlock` back to the root is the
 * active lineage: the same prose the caller's own `fragments`-based read
 * already produced, independently of this function.
 *
 * This only imports a branch whose own text is a fresh, unedited addition —
 * never one whose origin marks it as an edit, and never one that removed
 * existing prose. A branch that does not parse, or a lineage that cycles or
 * names an absent block, drops the whole retry history and is named in the
 * report; it never touches the active reading. */
export function alternatesFromNovelAiLegacyHistory(
  storyRaw: unknown,
  active: {
    readonly parts: readonly ImportedPart[];
    readonly room: number;
    readonly charsRoom: number;
  }
): NovelAiLegacyHistoryAlternates {
  if (!isPlainRecord(storyRaw) || storyRaw.datablocks === undefined || storyRaw.datablocks === null) {
    return { parts: [], fidelity: [] };
  }
  try {
    return build(storyRaw, active);
  } catch {
    return { parts: [], fidelity: ["retry history omitted: malformed"] };
  }
}

function build(
  storyRaw: Record<string, unknown>,
  active: {
    readonly parts: readonly ImportedPart[];
    readonly room: number;
    readonly charsRoom: number;
  }
): NovelAiLegacyHistoryAlternates {
  const datablocksRaw = storyRaw.datablocks;
  if (!Array.isArray(datablocksRaw)) throw new Error("Malformed datablocks");
  if (datablocksRaw.length > MAX_NOVELAI_RECORDS) throw new Error("Too many datablocks");
  const blocks = datablocksRaw.map((raw) => readBlock(raw, datablocksRaw.length));

  const currentBlock = storyRaw.currentBlock;
  if (!Number.isInteger(currentBlock) || (currentBlock as number) < 0 || (currentBlock as number) >= blocks.length) {
    throw new Error("Malformed currentBlock");
  }

  const lineage = walkLineage(currentBlock as number, blocks);
  validateGraph(blocks, lineage[0]!);
  const lineageStates = statesAlong(lineage, blocks, active.parts);

  const result: ImportedPart[] = [];
  const counters = { imported: 0, notAdditive: 0, malformed: 0, budgetHit: false };
  const visited = new Set<number>();
  let room = active.room;
  let charsRoom = active.charsRoom;

  const createdAt = new Date().toISOString();
  const importSubtree = (blockId: number, parentPartIndex: number | null, baseLength: number): void => {
    const pending = [{ blockId, parentPartIndex, baseLength }];
    while (pending.length > 0) {
      if (room <= 0 || charsRoom <= 0) {
        counters.budgetHit = true;
        return;
      }
      const next = pending.pop()!;
      if (visited.has(next.blockId)) {
        counters.malformed += 1;
        continue;
      }
      visited.add(next.blockId);
      const block = blocks[next.blockId];
      if (block === undefined) {
        counters.malformed += 1;
        continue;
      }
      if (!isPureAppend(block, next.baseLength)) {
        counters.notAdditive += 1;
        continue;
      }
      // A legacy block routinely carries blank lines after its prose. The
      // active legacy importer uses those lines as part boundaries. Remove
      // only that structural tail; preserve prose whitespace.
      const text = normalizeSectionText(block.text).replace(/(?:\n[ \t]*)+$/u, "");
      if (text.trim().length === 0) {
        counters.malformed += 1;
        continue;
      }
      if (text.length > charsRoom) {
        counters.budgetHit = true;
        continue;
      }
      const combinedIndex = active.parts.length + result.length;
      result.push({
        instruction: "",
        text,
        createdAt,
        parentIndex: next.parentPartIndex,
        active: false
      });
      room -= 1;
      charsRoom -= text.length;
      counters.imported += 1;
      const nextLength = next.baseLength + block.text.length;
      for (let index = block.nextBlock.length - 1; index >= 0; index -= 1) {
        pending.push({
          blockId: block.nextBlock[index]!,
          parentPartIndex: combinedIndex,
          baseLength: nextLength
        });
      }
    }
  };

  for (let pathIndex = 0; pathIndex < lineage.length; pathIndex += 1) {
    const id = lineage[pathIndex]!;
    const nextOnPath = lineage[pathIndex + 1];
    for (const childId of blocks[id]!.nextBlock) {
      if (childId === nextOnPath) continue;
      const state = lineageStates[pathIndex];
      if (state === null || state === undefined) {
        counters.notAdditive += 1;
        continue;
      }
      importSubtree(childId, state.parentIndex, state.sourceLength);
    }
  }

  const fidelity: string[] = [];
  if (counters.imported > 0) {
    fidelity.push(`${counters.imported} ${countNoun(counters.imported, "retry", "retries")} imported as unselected takes`);
  }
  if (counters.notAdditive > 0) {
    fidelity.push(
      `${counters.notAdditive} retry ${countNoun(counters.notAdditive, "branch", "branches")} omitted: not a simple continuation`
    );
  }
  if (counters.malformed > 0) {
    fidelity.push(
      `${counters.malformed} retry ${countNoun(counters.malformed, "branch", "branches")} omitted: malformed`
    );
  }
  if (counters.budgetHit) {
    fidelity.push("retry takes stopped: story is at the part or text limit");
  }
  return { parts: result, fidelity };
}

function readBlock(raw: unknown, blocksLength: number): LegacyBlock {
  if (!isPlainRecord(raw)) throw new Error("Malformed datablock");
  const dataFragment = raw.dataFragment;
  if (!isPlainRecord(dataFragment) || typeof dataFragment.data !== "string") {
    throw new Error("Malformed datablock fragment");
  }
  const nextRaw = raw.nextBlock;
  if (!Array.isArray(nextRaw)) throw new Error("Malformed nextBlock");
  const nextBlock = nextRaw.map((value) => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= blocksLength) {
      throw new Error("Malformed nextBlock reference");
    }
    return value as number;
  });
  if (new Set(nextBlock).size !== nextBlock.length) throw new Error("Duplicate nextBlock reference");
  const prevRaw = raw.prevBlock;
  let prevBlock: number | undefined;
  if (prevRaw === undefined || prevRaw === null || prevRaw === -1) {
    prevBlock = undefined;
  } else if (Number.isInteger(prevRaw) && (prevRaw as number) >= 0 && (prevRaw as number) < blocksLength) {
    prevBlock = prevRaw as number;
  } else {
    throw new Error("Malformed prevBlock reference");
  }
  const removedRaw = raw.removedFragments;
  const removed = removedRaw === undefined ? false : Array.isArray(removedRaw) ? removedRaw.length > 0 : true;
  const fragmentOrigin = typeof dataFragment.origin === "string" ? dataFragment.origin : null;
  const blockOrigin = typeof raw.origin === "string" ? raw.origin : null;
  const origin = fragmentOrigin === "edit" || blockOrigin === "edit"
    ? "edit"
    : fragmentOrigin ?? blockOrigin;
  const startIndex = Number.isSafeInteger(raw.startIndex) && (raw.startIndex as number) >= 0
    ? raw.startIndex as number
    : null;
  if (hasUnpairedSurrogate(dataFragment.data)) throw new Error("Malformed datablock text");
  return { text: dataFragment.data, origin, nextBlock, prevBlock, removed, startIndex };
}

/** The chain from `currentBlock` back to the root, in root-first order. */
function walkLineage(currentBlock: number, blocks: readonly LegacyBlock[]): readonly number[] {
  const path: number[] = [];
  const onPath = new Set<number>();
  let cursor = currentBlock;
  for (let steps = 0; ; steps += 1) {
    if (steps > blocks.length || onPath.has(cursor)) throw new Error("History cycle");
    path.push(cursor);
    onPath.add(cursor);
    const block = blocks[cursor];
    if (block === undefined) throw new Error("Lineage names an absent block");
    if (block.prevBlock === undefined) break;
    cursor = block.prevBlock;
  }
  path.reverse();
  return path;
}

/** Reconstruct only a lineage prefix that is proven to contain append
 * operations. A later edit makes it unsafe to infer any following boundary. */
function statesAlong(
  lineage: readonly number[],
  blocks: readonly LegacyBlock[],
  activeParts: readonly ImportedPart[]
): readonly ({ readonly sourceLength: number; readonly parentIndex: number | null } | null)[] {
  const states: ({ readonly sourceLength: number; readonly parentIndex: number | null } | null)[] = [];
  let sourceLength = 0;
  let safe = true;
  let prefixMatches = true;
  let pendingLine = "";
  let activePartIndex = 0;
  for (const id of lineage) {
    const block = blocks[id]!;
    if (!safe || !isPureAppend(block, sourceLength)) {
      safe = false;
      states.push(null);
      continue;
    }
    sourceLength += block.text.length;
    const normalized = normalizeSectionText(block.text);
    let start = 0;
    for (let index = 0; index <= normalized.length; index += 1) {
      if (index < normalized.length && normalized[index] !== "\n") continue;
      pendingLine += normalized.slice(start, index);
      start = index + 1;
      if (index === normalized.length) break;
      if (pendingLine.trim().length > 0) {
        if (activeParts[activePartIndex]?.text !== pendingLine) prefixMatches = false;
        activePartIndex += 1;
      }
      pendingLine = "";
    }
    states.push(prefixMatches && pendingLine.length === 0
      ? { sourceLength, parentIndex: activePartIndex === 0 ? null : activePartIndex - 1 }
      : null);
  }
  return states;
}

function isPureAppend(block: LegacyBlock, baseLength: number): boolean {
  return !block.removed
    && block.origin !== null
    && block.origin !== "edit"
    && block.startIndex === baseLength;
}

/** Require one connected tree whose forward and backward references agree.
 * This rejects cycles, shared children, and detached ambiguous histories
 * before any optional take is admitted. */
function validateGraph(blocks: readonly LegacyBlock[], rootId: number): void {
  if (blocks[rootId]?.prevBlock !== undefined) throw new Error("History root has a parent");
  const referenced = new Uint8Array(blocks.length);
  for (let parentId = 0; parentId < blocks.length; parentId += 1) {
    for (const childId of blocks[parentId]!.nextBlock) {
      if (blocks[childId]!.prevBlock !== parentId) throw new Error("History references disagree");
      if (referenced[childId] !== 0) throw new Error("History graph has a shared child");
      referenced[childId] = 1;
    }
  }
  for (let childId = 0; childId < blocks.length; childId += 1) {
    if (childId === rootId) continue;
    const parentId = blocks[childId]!.prevBlock;
    if (parentId === undefined || referenced[childId] === 0) {
      throw new Error("History block is detached");
    }
  }
  const visited = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) throw new Error("History graph has a cycle or shared child");
    visited.add(id);
    stack.push(...blocks[id]!.nextBlock);
  }
  if (visited.size !== blocks.length) throw new Error("History graph is disconnected");
}
