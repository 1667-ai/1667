import { MAX_TOTAL_CHARS, type ImportedPart } from "./import-model.js";
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
import { MAX_NOVELAI_RECORDS } from "./import-nai-msgpack-preflight.js";

const MAX_NOVELAI_HISTORY_REPLAY_WORK = MAX_NOVELAI_RECORDS * 8;
const MAX_NOVELAI_HISTORY_TEXT_REPLAY_WORK = MAX_TOTAL_CHARS * 8;

class HistoryReplayLimitError extends Error {}

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
  } catch (error) {
    if (error instanceof HistoryReplayLimitError) {
      return { parts: [], fidelity: ["retry history omitted: replay work limit reached"] };
    }
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
  if (!isPlainRecord(historyRaw)) {
    throw new Error("Malformed history");
  }
  if (Array.isArray(historyRaw.nodes) && historyRaw.nodes.length === 0) {
    return { parts: [], fidelity: [] };
  }
  if (!(historyRaw.nodes instanceof Map || isPlainRecord(historyRaw.nodes))) {
    throw new Error("Malformed history nodes");
  }
  const nodes = readHistoryNodes(historyRaw.nodes);
  if (nodes.size === 0) return { parts: [], fidelity: [] };

  const root = sectionId(historyRaw.root, "history root");
  const current = sectionId(historyRaw.current, "history current");
  if (!nodes.has(root) || !nodes.has(current)) throw new Error("Malformed history endpoints");

  const childrenByParent = new Map<SectionId, SectionId[]>();
  for (const [id, node] of nodes) {
    if (id === root) {
      if (node.parent !== undefined) throw new Error("History root has a parent");
      continue;
    }
    if (node.parent === undefined) throw new Error("History has more than one root");
    if (!nodes.has(node.parent)) throw new Error("History node names an absent parent");
    const siblings = childrenByParent.get(node.parent) ?? [];
    siblings.push(id);
    childrenByParent.set(node.parent, siblings);
  }
  validateHistoryReachability(root, nodes, childrenByParent);
  const pathOrder = walkToRoot(current, root, nodes);

  const result: ImportedPart[] = [];
  const counters = { imported: 0, notAdditive: 0, malformed: 0, budgetHit: false };
  const visited = new Set<SectionId>();
  let replayTextWork = 0;
  const claimReplayTextWork = (units: number): void => {
    if (units > MAX_NOVELAI_HISTORY_TEXT_REPLAY_WORK - replayTextWork) {
      throw new HistoryReplayLimitError("NovelAI history text replay work limit reached");
    }
    replayTextWork += units;
  };
  const normalizedText = new Map<SectionId, { readonly source: string; readonly text: string }>();
  const normalizeText = (id: SectionId, text: string): string => {
    const cached = normalizedText.get(id);
    if (cached?.source === text) return cached.text;
    claimReplayTextWork(text.length);
    const normalized = normalizeSectionText(text);
    normalizedText.set(id, { source: text, text: normalized });
    return normalized;
  };
  let room = active.room;
  let charsRoom = active.charsRoom;
  let replayWork = 0;
  const claimReplayWork = (units: number): void => {
    if (units > MAX_NOVELAI_HISTORY_REPLAY_WORK - replayWork) {
      throw new HistoryReplayLimitError("NovelAI history replay work limit reached");
    }
    replayWork += units;
  };

  const sections = new Map<SectionId, NovelAiSection>();
  let order: readonly SectionId[] = [];
  for (let pathIndex = 0; pathIndex < pathOrder.length; pathIndex += 1) {
    const id = pathOrder[pathIndex]!;
    const node = nodes.get(id)!;
    order = applyChanges(
      sections,
      order,
      node.changesRaw,
      claimReplayWork,
      claimReplayTextWork
    );
    const kids = childrenByParent.get(id) ?? [];
    const nextOnPath = pathOrder[pathIndex + 1];
    const alternateKids = kids.filter((kid) => kid !== nextOnPath);
    if (alternateKids.length === 0) continue;
    claimReplayWork(order.length);
    const baseline = matchingActiveBaseline(
      order,
      sections,
      active.parts,
      active.sectionIndex,
      normalizeText
    );
    for (const kid of alternateKids) {
      if (baseline === null) {
        counters.notAdditive += 1;
        continue;
      }
      importSubtree(kid, baseline.parentPartIndex, sections, order, id === root);
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
      placedIndex: ReadonlyMap<SectionId, number>;
      allowRoot: boolean;
    }> = [{
      nodeId: startNodeId,
      parentPartIndex: startParentPartIndex,
      baseSections: startSections,
      baseOrder: startOrder,
      placedIndex: active.sectionIndex,
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
          claimReplayWork(replayCost(frame.baseSections.size, frame.baseOrder.length, changeSteps.length));
          claimReplayTextWork(replayTextCost(frame.baseSections, changeSteps));
          const changedSections = new Map(frame.baseSections);
          newOrder = applyDirtySections(changedSections, frame.baseOrder, asMapOrRecord(node.changesRaw));
          newSections = changedSections;
        } catch (error) {
          if (error instanceof HistoryReplayLimitError) throw error;
          counters.malformed += 1;
          continue;
        }
        if (!startsWithOrder(newOrder, frame.baseOrder)) {
          counters.notAdditive += 1;
          continue;
        }
      }
      let precedingPartIndex = frame.parentPartIndex;
      let placedIndex: ReadonlyMap<SectionId, number> = frame.placedIndex;
      let mutablePlacedIndex: Map<SectionId, number> | undefined;
      let stopSubtree = false;
      if (changeSteps.length > 0) {
        const baseOrderSet = new Set(frame.baseOrder);
        const nodeDate = historyNodeDate(node.date);
        for (const id of newOrder) {
          if (baseOrderSet.has(id)) {
            const known = frame.placedIndex.get(id);
            if (known !== undefined) precedingPartIndex = known;
            continue;
          }
          const section = newSections.get(id);
          if (section === undefined || section.type !== 1) continue;
          const text = normalizeText(id, section.text);
          if (text.trim().length === 0) continue;
          if (precedingPartIndex === null && !frame.allowRoot) {
            counters.notAdditive += 1;
            stopSubtree = true;
            break;
          }
          if (room <= 0 || text.length > charsRoom) {
            counters.budgetHit = true;
            stopSubtree = true;
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
          mutablePlacedIndex ??= new Map(frame.placedIndex);
          mutablePlacedIndex.set(id, combinedIndex);
          placedIndex = mutablePlacedIndex;
          precedingPartIndex = combinedIndex;
        }
      }
      if (stopSubtree) continue;

      const children = childrenByParent.get(frame.nodeId) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({
          nodeId: children[index]!,
          parentPartIndex: precedingPartIndex,
          baseSections: newSections,
          baseOrder: newOrder,
          placedIndex,
          allowRoot: false
        });
      }
    }
  }

  return { parts: result, fidelity: retryHistoryFidelity(counters) };
}

function validateHistoryReachability(
  root: SectionId,
  nodes: ReadonlyMap<SectionId, HistoryNode>,
  childrenByParent: ReadonlyMap<SectionId, readonly SectionId[]>
): void {
  const visited = new Set<SectionId>();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) throw new Error("History graph has a cycle");
    visited.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  if (visited.size !== nodes.size) throw new Error("History graph is disconnected");
}

function applyChanges(
  sections: Map<SectionId, NovelAiSection>,
  order: readonly SectionId[],
  changesRaw: unknown,
  claimReplayWork: (units: number) => void,
  claimReplayTextWork: (units: number) => void
): readonly SectionId[] {
  if (changesRaw === undefined) return order;
  const changes = asMapOrRecord(changesRaw);
  const changeSteps = [...boundedEntries(changes, "history node changes")];
  claimReplayWork(replayCost(sections.size, order.length, changeSteps.length));
  claimReplayTextWork(replayTextCost(sections, changeSteps));
  return applyDirtySections(sections, order, changes);
}

/** Charge map copies, order scans, and change scans before replay starts. */
function replayCost(sectionCount: number, orderCount: number, changeCount: number): number {
  return sectionCount + orderCount * 2 + changeCount * 2;
}

/** Charge text validation and full-string diff reconstruction before replay. */
function replayTextCost(
  sections: ReadonlyMap<SectionId, NovelAiSection>,
  changes: readonly [unknown, unknown][]
): number {
  let total = 0;
  for (const [rawId, rawStep] of changes) {
    if (!isPlainRecord(rawStep)) continue;
    if (rawStep.type === 0) {
      total += rawSectionTextLength(rawStep.section);
      continue;
    }
    if (rawStep.type === 1) {
      const id = sectionId(rawId, "history text replay");
      const existing = sections.get(id);
      if (existing?.type === 1) total += existing.text.length * 4;
      continue;
    }
    if (rawStep.type === 2) total += rawSectionTextLength(rawStep.previous);
  }
  return total;
}

function rawSectionTextLength(value: unknown): number {
  return isPlainRecord(value) && value.type === 1 && typeof value.text === "string"
    ? value.text.length
    : 0;
}

function startsWithOrder(order: readonly SectionId[], prefix: readonly SectionId[]): boolean {
  if (order.length < prefix.length) return false;
  return prefix.every((id, index) => order[index] === id);
}

function matchingActiveBaseline(
  order: readonly SectionId[],
  sections: ReadonlyMap<SectionId, NovelAiSection>,
  activeParts: readonly ImportedPart[],
  activeSectionIndex: ReadonlyMap<SectionId, number>,
  normalizeText: (id: SectionId, text: string) => string
): { readonly parentPartIndex: number | null } | null {
  let partIndex = 0;
  for (const id of order) {
    const section = sections.get(id);
    if (section === undefined) return null;
    if (section.type !== 1) continue;
    const text = normalizeText(id, section.text);
    if (text.trim().length === 0) continue;
    if (activeSectionIndex.get(id) !== partIndex || activeParts[partIndex]?.text !== text) return null;
    partIndex += 1;
  }
  return { parentPartIndex: partIndex === 0 ? null : partIndex - 1 };
}

function asMapOrRecord(value: unknown): Map<unknown, unknown> | Record<string, unknown> {
  if (value instanceof Map) return value;
  if (isPlainRecord(value)) return value;
  throw new Error("Malformed history changes");
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
