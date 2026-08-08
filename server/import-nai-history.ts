import type { ImportedPart } from "./import-model.js";
import { retryHistoryFidelity } from "./import-retry-fidelity.js";
import {
  type NovelAiSection,
  type SectionId,
  applyDirtySections,
  boundedEntries,
  isPlainRecord,
  normalizeSectionText,
  sectionId
} from "./import-nai-sections.js";

export interface NovelAiHistoryAlternates {
  /** New parts, each carrying `parentIndex` and `active: false`. `parentIndex`
   *  is relative to the combined array: the active parts the caller already
   *  built, followed by these, in this order. */
  readonly parts: readonly ImportedPart[];
  readonly fidelity: readonly string[];
}

interface HistoryNode {
  readonly parent: SectionId | undefined;
  readonly changesRaw: unknown;
  readonly date: unknown;
}

/** Turn a NovelAI Document's `history` — the retry tree behind every swipe
 * and regeneration — into 1667 alternate takes.
 *
 * `history` is a checkpoint tree: `root` is the story's first checkpoint,
 * `current` is the one the top-level `sections`/`order` already reflect, and
 * each node's `changes` is a section diff on top of its parent, in the exact
 * shape the Document's own `dirtySections` uses. A node with more than one
 * child recorded a retry: each child is a candidate continuation, and only
 * one of them is an ancestor of `current`.
 *
 * This only imports a branch that is a pure, well-formed extension of its
 * parent — new sections only, anchored at an existing or a same-batch
 * section. A branch that edits or removes shared prose, or that does not
 * parse, is dropped and named in the report; it never touches the active
 * reading, which the caller already built independently of this function. */
export function alternatesFromNovelAiHistory(
  historyRaw: unknown,
  active: {
    readonly parts: readonly ImportedPart[];
    readonly sectionIndex: ReadonlyMap<SectionId, number>;
    readonly room: number;
    readonly charsRoom: number;
  }
): NovelAiHistoryAlternates {
  if (historyRaw === undefined || historyRaw === null) return { parts: [], fidelity: [] };
  try {
    return build(historyRaw, active);
  } catch {
    return { parts: [], fidelity: ["retry history omitted: malformed"] };
  }
}

function build(
  historyRaw: unknown,
  active: {
    readonly parts: readonly ImportedPart[];
    readonly sectionIndex: ReadonlyMap<SectionId, number>;
    readonly room: number;
    readonly charsRoom: number;
  }
): NovelAiHistoryAlternates {
  if (!isPlainRecord(historyRaw) || !(historyRaw.nodes instanceof Map || isPlainRecord(historyRaw.nodes))) {
    throw new Error("Malformed history");
  }
  const nodes = readHistoryNodes(historyRaw.nodes);
  if (nodes.size === 0) return { parts: [], fidelity: [] };

  const root = sectionId(historyRaw.root, "history root");
  const current = sectionId(historyRaw.current, "history current");
  if (!nodes.has(root) || !nodes.has(current)) throw new Error("Malformed history endpoints");

  const pathOrder = walkToRoot(current, root, nodes);

  const childrenByParent = new Map<SectionId, SectionId[]>();
  for (const [id, node] of nodes) {
    if (node.parent === undefined) continue;
    if (!nodes.has(node.parent)) throw new Error("History node names an absent parent");
    const siblings = childrenByParent.get(node.parent) ?? [];
    siblings.push(id);
    childrenByParent.set(node.parent, siblings);
  }

  const result: ImportedPart[] = [];
  const counters = { imported: 0, notAdditive: 0, malformed: 0, budgetHit: false };
  const visited = new Set<SectionId>();
  const placedIndex = new Map<SectionId, number>(active.sectionIndex);
  let room = active.room;
  let charsRoom = active.charsRoom;

  const sections = new Map<SectionId, NovelAiSection>();
  let order: readonly SectionId[] = [];
  for (let pathIndex = 0; pathIndex < pathOrder.length; pathIndex += 1) {
    const id = pathOrder[pathIndex]!;
    const node = nodes.get(id)!;
    order = applyChanges(sections, order, node.changesRaw);
    const kids = childrenByParent.get(id) ?? [];
    const nextOnPath = pathOrder[pathIndex + 1];
    for (const kid of kids) {
      if (kid === nextOnPath) continue;
      const parentPartIndex = nearestPlacedIndex(order, placedIndex);
      importSubtree(kid, parentPartIndex, sections, order, id === root);
    }
  }

  function importSubtree(
    startNodeId: SectionId,
    startParentPartIndex: number | null,
    startSections: ReadonlyMap<SectionId, NovelAiSection>,
    startOrder: readonly SectionId[],
    startAllowRoot: boolean
  ): void {
    const pending: Array<{
      nodeId: SectionId;
      parentPartIndex: number | null;
      baseSections: ReadonlyMap<SectionId, NovelAiSection>;
      baseOrder: readonly SectionId[];
      allowRoot: boolean;
    }> = [{
      nodeId: startNodeId,
      parentPartIndex: startParentPartIndex,
      baseSections: startSections,
      baseOrder: startOrder,
      allowRoot: startAllowRoot
    }];

    while (pending.length > 0) {
      if (room <= 0 || charsRoom <= 0) {
        counters.budgetHit = true;
        break;
      }
      const frame = pending.pop()!;
      if (visited.has(frame.nodeId)) continue;
      visited.add(frame.nodeId);
      const node = nodes.get(frame.nodeId);
      if (node === undefined) {
        counters.malformed += 1;
        continue;
      }

      let changeSteps: readonly [unknown, unknown][];
      try {
        changeSteps = [...boundedEntries(asMapOrRecord(node.changesRaw), "history node changes")];
      } catch {
        counters.malformed += 1;
        continue;
      }
      if (changeSteps.some(([, step]) => !isPlainRecord(step) || step.type !== 0)) {
        counters.notAdditive += 1;
        continue;
      }

      let newSections: ReadonlyMap<SectionId, NovelAiSection> = frame.baseSections;
      let newOrder = frame.baseOrder;
      if (changeSteps.length > 0) {
        try {
          const changedSections = new Map(frame.baseSections);
          newOrder = applyDirtySections(changedSections, frame.baseOrder, asMapOrRecord(node.changesRaw));
          newSections = changedSections;
        } catch {
          counters.malformed += 1;
          continue;
        }
      }

      let precedingPartIndex = frame.parentPartIndex;
      if (changeSteps.length > 0) {
        const baseOrderSet = new Set(frame.baseOrder);
        const nodeDate = historyNodeDate(node.date);
        for (const id of newOrder) {
          if (baseOrderSet.has(id)) {
            const known = placedIndex.get(id);
            if (known !== undefined) precedingPartIndex = known;
            continue;
          }
          const section = newSections.get(id);
          if (section === undefined || section.type !== 1) continue;
          const text = normalizeSectionText(section.text);
          if (text.trim().length === 0) continue;
          if (precedingPartIndex === null && !frame.allowRoot) continue;
          if (room <= 0 || text.length > charsRoom) {
            counters.budgetHit = true;
            break;
          }
          const combinedIndex = active.parts.length + result.length;
          result.push({
            instruction: "",
            text,
            createdAt: nodeDate,
            parentIndex: precedingPartIndex,
            active: false
          });
          room -= 1;
          charsRoom -= text.length;
          counters.imported += 1;
          placedIndex.set(id, combinedIndex);
          precedingPartIndex = combinedIndex;
        }
      }

      const children = childrenByParent.get(frame.nodeId) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({
          nodeId: children[index]!,
          parentPartIndex: precedingPartIndex,
          baseSections: newSections,
          baseOrder: newOrder,
          allowRoot: false
        });
      }
    }
  }

  return { parts: result, fidelity: retryHistoryFidelity(counters) };
}

function applyChanges(
  sections: Map<SectionId, NovelAiSection>,
  order: readonly SectionId[],
  changesRaw: unknown
): readonly SectionId[] {
  if (changesRaw === undefined) return order;
  return applyDirtySections(sections, order, asMapOrRecord(changesRaw));
}

function asMapOrRecord(value: unknown): Map<unknown, unknown> | Record<string, unknown> {
  if (value instanceof Map) return value;
  if (isPlainRecord(value)) return value;
  return new Map();
}

/** The nearest section in `order`, scanning from the end, that this history
 *  branch's baseline shares with the active reading. `null` when nothing in
 *  `order` survived into the active reading — a fresh alternate then becomes
 *  a new root instead of an orphan. */
function nearestPlacedIndex(
  order: readonly SectionId[],
  placedIndex: ReadonlyMap<SectionId, number>
): number | null {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const found = placedIndex.get(order[index]!);
    if (found !== undefined) return found;
  }
  return null;
}

function walkToRoot(
  current: SectionId,
  root: SectionId,
  nodes: ReadonlyMap<SectionId, HistoryNode>
): readonly SectionId[] {
  const path: SectionId[] = [current];
  let cursor = current;
  for (let steps = 0; cursor !== root; steps += 1) {
    if (steps > nodes.size) throw new Error("History parent chain has a cycle");
    const node = nodes.get(cursor);
    if (node === undefined || node.parent === undefined) throw new Error("History current does not reach root");
    cursor = node.parent;
    path.push(cursor);
  }
  path.reverse();
  return path;
}

function readHistoryNodes(raw: unknown): Map<SectionId, HistoryNode> {
  const nodes = new Map<SectionId, HistoryNode>();
  for (const [rawId, rawNode] of boundedEntries(raw as Map<unknown, unknown> | Record<string, unknown>, "history nodes")) {
    const id = sectionId(rawId, "history nodes map");
    if (!isPlainRecord(rawNode)) throw new Error("Malformed history node");
    const parent = rawNode.parent === undefined || rawNode.parent === null
      ? undefined
      : sectionId(rawNode.parent, "history node parent");
    if (nodes.has(id)) throw new Error("Duplicate history node ID");
    nodes.set(id, { parent, changesRaw: rawNode.changes, date: rawNode.date });
  }
  return nodes;
}

function historyNodeDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}
