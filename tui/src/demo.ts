import { countWords } from "../../shared/story-text.js";
import { normalizeAuthorsNoteDepth } from "../../shared/authors-note.js";
import { nodeStubHasInstruction, nodeStubPreviewText } from "../../shared/node-stub.js";
import {
  activeHumanAttribution,
  attributionAfterHumanEdit,
  attributionAfterReplacement,
  rewrittenSpansAfterReplacement
} from "../../shared/human-edit.js";
import { estimateTokens } from "../../shared/tokens.js";
import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { activePath, computeRollups, isChapterSummary, pathTo, subtreeIds, switchToNode, unusedTakePruneSelection } from "../../shared/story-tree.js";
import type {
  FactInput,
  FactPatch,
  GenerationSettings,
  NodeStub,
  PruneUnusedTakesRequest,
  RewriteDestination,
  Story,
  StoryPayload,
  StorySummary,
  TagStatus
} from "../../shared/types.js";
import { MAX_FACTS, resolveRewriteDestination } from "../../shared/types.js";
import { planCardImport } from "../../shared/card-import.js";
import { DEFAULT_FACT_SCAN_PARTS, factMetadataOverrides } from "../../shared/fact-metadata.js";
import type {
  ModelDiscoveryResultV2,
  SamplingPhraseBiasEntryV2,
  SettingsDocumentV2,
  SettingsMutationResult,
  SettingsView
} from "../../shared/settings-v2-types.js";
import {
  buildSearchCorpus,
  createSearchScan,
  searchQueryIsRunnable,
  type SearchHit,
  type SearchRequest,
  type SearchResponse
} from "../../shared/story-search.js";
import type { RemovedChapterBreak, StoryApi } from "./api.js";
import type { AppSource } from "./app.js";
import { normalizeUserConfig } from "./config.js";
import { demoResolveSamplingBias } from "./demo-token-ids.js";
import { streamFake } from "./fake-stream.js";
import {
  createDemoChapterBreak,
  DEMO_SUMMARY_TEXT,
  editDemoChapterSummary,
  removeDemoChapterBreak,
  renameDemoChapterBreak,
  restoreDemoChapterBreak,
  summarizeDemoChapter
} from "./demo-chapters.js";
import { buildDemoNodes, DEMO_CREATED_AT, DEMO_EDITED_AT, demoTags, demoFacts, makeDemoNode } from "./demo-fixture.js";
import { createDemoTake } from "./demo-take.js";

export { DEMO_SUMMARY_TEXT } from "./demo-chapters.js";

const CREATED = DEMO_CREATED_AT;
const EDITED = DEMO_EDITED_AT;

export const DEMO_CONTINUE_TEXT = " while the compass needle scratched one small circle in the wood.";
export const DEMO_GENERATED_TEXT = " The lantern flame bent toward the compass, though no door had opened.";
export const DEMO_REWRITE_TEXT = "the lantern's flame steadied and held";
export interface DemoController {
  payload(): StoryPayload;
  switchTo(nodeId: string, options?: { stopAtNode?: boolean }): StoryPayload;
  appendGenerated(instruction: string, text: string, append: boolean, genId?: string): StoryPayload;
  /** New child of `parentId` (write-here sibling / regenerate take), made active. */
  createChild(
    parentId: string | null,
    instruction: string,
    text: string,
    human?: boolean,
    genId?: string
  ): StoryPayload;
  createEditedTake(sourceNodeId: string, instruction: string, text: string): StoryPayload;
  addSummaryTake(text: string): StoryPayload;
  editNode(nodeId: string, patch: { instruction?: string; text?: string }): StoryPayload;
  /** Splice [start, end) with a model replacement, exactly the attribution
   *  and rewritten-span shapes `applyRewrite` (server/story-provider-effect.ts)
   *  commits — never the human-edit path `editNode` uses, which would credit
   *  the writer with words the model wrote. `destination` mirrors
   *  `resolveRewriteDestination` (shared/types.ts): absent or "in-place"
   *  mutates `nodeId` itself; "take" commits a new sibling instead, the only
   *  shape this returned before issue #319. A chapter summary never reaches
   *  this: it is not on the active path, so nothing upstream can ever
   *  resolve one as a rewrite target. Returns the id of the node the
   *  replacement landed on — `nodeId` itself for "in-place", a fresh id for
   *  "take". */
  rewriteNode(
    nodeId: string, start: number, end: number, replacement: string, destination?: RewriteDestination
  ): { payload: StoryPayload; nodeId: string };
  deleteNode(nodeId: string, expectedSubtreeCount: number): StoryPayload;
  pruneUnusedTakes(expected: PruneUnusedTakesRequest): StoryPayload;
  putBookmark(nodeId: string, name: string, status: TagStatus): StoryPayload;
  deleteBookmark(nodeId: string): StoryPayload;
  listStories(): StorySummary[];
  openStory(id: string): StoryPayload;
  createStory(): StoryPayload;
  renameStory(title: string): StoryPayload;
  setAuthorsNote(authorsNote: string, depth?: number): StoryPayload;
  setAuthorBrief(authorBrief: string): StoryPayload;
  setFactsBudget(budgetTokens: number | null): StoryPayload;
  setPhraseBias(phraseBias: readonly SamplingPhraseBiasEntryV2[]): StoryPayload;
  setBannedStrings(bannedStrings: readonly string[]): StoryPayload;
  deleteStory(): StoryPayload;
  autonameStory(): StoryPayload;
  createFact(input: FactInput): StoryPayload;
  patchFact(id: string, input: FactPatch): StoryPayload;
  deleteFact(id: string): StoryPayload;
  reorderFact(id: string, toIndex: number): StoryPayload;
  createChapterBreak(parentPartId: string, title?: string): { payload: StoryPayload; breakId: string };
  renameChapterBreak(breakId: string | null, title: string): StoryPayload;
  removeChapterBreak(breakId: string): { payload: StoryPayload; removed: RemovedChapterBreak };
  restoreChapterBreak(breakId: string, removed: RemovedChapterBreak): StoryPayload;
  summarizeChapter(breakId: string): StoryPayload;
  editChapterSummary(summaryId: string, text: string): StoryPayload;
  exportMarkdown(): string;
  searchStories(request: SearchRequest): SearchResponse;
}

export function createDemoController(dense = false): DemoController {
  const nodes = buildDemoNodes(dense);
  let story: Story = {
    id: "demo-lantern-keeper",
    title: "the lantern keeper",
    createdAt: CREATED,
    updatedAt: CREATED,
    nodes,
    activeRootId: "p1",
    recentNodeIds: [],
    tags: demoTags(),
    facts: demoFacts(),
    chapterBreaks: [
      { id: "chapter-break-1", parentPartId: "p5", title: "The Stranger", createdAt: CREATED },
      { id: "chapter-break-2", parentPartId: "p10", title: "The Compass", createdAt: CREATED }
    ]
  };
  const deleteDemoNode = (nodeId: string, expectedSubtreeCount: number): StoryPayload => {
    const ids = subtreeIds(story, nodeId);
    if (ids.length !== expectedSubtreeCount) throw new Error(`Prune changed: expected ${expectedSubtreeCount}, found ${ids.length}`);
    const node = story.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) throw new Error(`Unknown demo node: ${nodeId}`);
    const activeIds = new Set(activePath(story).map((candidate) => candidate.id));
    if (activeIds.has(nodeId)) {
      if (node.parentId === null) {
        story.activeRootId = story.nodes.find((candidate) => candidate.parentId === null && !ids.includes(candidate.id))?.id ?? null;
      } else {
        const parent = pathTo(story, nodeId).at(-2)!;
        parent.activeChildId = null;
      }
    }
    const removed = new Set(ids);
    story.nodes = story.nodes.filter((candidate) => !removed.has(candidate.id));
    story.chapterBreaks = story.chapterBreaks.filter((chapterBreak) => !removed.has(chapterBreak.parentPartId));
    story.tags = story.tags.filter((tag) => !removed.has(tag.nodeId));
    return payloadFrom(story);
  };
  function listDemoStories(): StorySummary[] {
    const current = storySummary(story);
    return [current,
      { id: "demo-salt-road", title: "salt road almanac", updatedAt: "2026-07-18T09:00:00.000Z", partCount: 27, words: 6_412, forked: false, lineCount: 4 },
      { id: "demo-winter-orchard", title: "the winter orchard", updatedAt: "2026-07-12T09:00:00.000Z", partCount: 18, words: 4_206, forked: false, lineCount: 2 },
      { id: "demo-glass-tide", title: "a glass tide", updatedAt: "2026-06-02T09:00:00.000Z", partCount: 9, words: 1_884, forked: true, lineCount: 3 }
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  }
  return {
    payload: () => payloadFrom(story),
    switchTo(nodeId, options) {
      switchToNode(story, nodeId, options);
      return payloadFrom(story);
    },
    appendGenerated(instruction, text, append, genId) {
      const leaf = activePath(story).at(-1) ?? null;
      if (append && leaf !== null) {
        leaf.text += text;
        leaf.updatedAt = CREATED;
        // Append rewrites genId like the backend; updatedAt still marks impure.
        if (genId !== undefined) leaf.genId = genId;
      } else {
        const id = `demo-generated-${story.nodes.length + 1}`;
        const node = makeDemoNode(
          id,
          leaf?.id ?? null,
          instruction,
          text,
          genId === undefined ? undefined : { genId }
        );
        story.nodes.push(node);
        if (leaf === null) story.activeRootId = id;
        else leaf.activeChildId = id;
      }
      return payloadFrom(story);
    },
    createChild(parentId, instruction, text, human = false, genId) {
      createDemoTake(story, parentId, instruction, text, human, { genId });
      return payloadFrom(story);
    },
    createEditedTake(sourceNodeId, instruction, text) {
      const source = story.nodes.find((node) => node.id === sourceNodeId);
      if (source === undefined) throw new Error(`Unknown demo node: ${sourceNodeId}`);
      createDemoTake(story, source.parentId, instruction, text, source.human === true, { source });
      return payloadFrom(story);
    },
    addSummaryTake(text) {
      const leaf = activePath(story).at(-1) ?? null;
      const id = `demo-summary-${story.nodes.length + 1}`;
      const node = makeDemoNode(id, leaf?.id ?? null, "summarize the story so far", text, { role: "summary" });
      story.nodes.push(node);
      if (leaf === null) story.activeRootId = id;
      else leaf.activeChildId = id;
      return payloadFrom(story);
    },
    editNode(nodeId, patch) {
      const node = story.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) throw new Error(`Unknown demo node: ${nodeId}`);
      if (patch.instruction !== undefined) node.instruction = patch.instruction;
      if (patch.text !== undefined) {
        node.attribution = attributionAfterHumanEdit(node.attribution, node.text, patch.text);
        node.text = patch.text;
      }
      node.updatedAt = EDITED;
      return payloadFrom(story);
    },
    rewriteNode(nodeId, start, end, replacement, destination) {
      const node = story.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) throw new Error(`Unknown demo node: ${nodeId}`);
      const originalText = node.text;
      const attribution = attributionAfterReplacement(
        activeHumanAttribution(node), start, end, replacement.length, originalText.length
      );
      const rewrittenSpans = rewrittenSpansAfterReplacement(node.rewrittenSpans, start, end, replacement.length);
      const text = originalText.slice(0, start) + replacement + originalText.slice(end);
      if (resolveRewriteDestination(destination) !== "take") {
        // Mirrors `applyRewrite`'s in-place branch: mutate the same node,
        // mint nothing new — issue #319's new default.
        node.text = text;
        node.attribution = attribution;
        node.rewrittenSpans = rewrittenSpans;
        node.updatedAt = EDITED;
        return { payload: payloadFrom(story), nodeId: node.id };
      }
      const take = createDemoTake(story, node.parentId, node.instruction, text, node.human === true, {
        source: node,
        attributionOverride: attribution,
        rewrittenSpansOverride: rewrittenSpans
      });
      return { payload: payloadFrom(story), nodeId: take.id };
    },
    deleteNode(nodeId, expectedSubtreeCount) {
      return deleteDemoNode(nodeId, expectedSubtreeCount);
    },
    pruneUnusedTakes(expected) {
      if (story.updatedAt !== expected.expectedStoryRevision) {
        throw new Error("The story changed after the prune preview — reload it and review again.");
      }
      const selection = unusedTakePruneSelection(story);
      if (selection.takeIds.length !== expected.expectedTakeCount
        || selection.nodeIds.length !== expected.expectedPartCount) {
        throw new Error("The prune selection changed — reload the story and review it again.");
      }
      for (const takeId of selection.takeIds) deleteDemoNode(takeId, subtreeIds(story, takeId).length);
      return payloadFrom(story);
    },
    putBookmark(nodeId, name, status) {
      const existing = story.tags.find((tag) => tag.nodeId === nodeId);
      // Canon is a singleton, exactly as the backend enforces it: the line that
      // loses it becomes the alternative it now is. The demo fixture ships a
      // Canon tag, so without this the demo would show two.
      if (status === "Canon") {
        for (const other of story.tags) {
          if (other.nodeId !== nodeId && other.status === "Canon") other.status = "Alt";
        }
      }
      const tag = { nodeId, name, status, color: tagColor(status), createdAt: CREATED };
      if (existing === undefined) story.tags.push(tag);
      else Object.assign(existing, tag);
      return payloadFrom(story);
    },
    deleteBookmark(nodeId) {
      story.tags = story.tags.filter((tag) => tag.nodeId !== nodeId);
      return payloadFrom(story);
    },
    listStories() {
      return listDemoStories();
    },
    openStory(id) {
      if (id === story.id) return payloadFrom(story);
      const listed = listDemoStories().find((candidate) => candidate.id === id);
      if (listed === undefined) throw new Error(`Unknown demo story: ${id}`);
      story = { ...story, id, title: listed.title, updatedAt: listed.updatedAt, tags: [], recentNodeIds: [] };
      return payloadFrom(story);
    },
    createStory() {
      story = { id: `demo-new-${Date.now()}`, title: "Untitled", createdAt: CREATED, updatedAt: CREATED,
        nodes: [], activeRootId: null, recentNodeIds: [], tags: [], facts: [], chapterBreaks: [] };
      return payloadFrom(story);
    },
    renameStory(title) { story.title = title; story.updatedAt = CREATED; return payloadFrom(story); },
    setAuthorsNote(authorsNote, depth) {
      const normalized = authorsNote.trim().length === 0 ? undefined : authorsNote;
      if (normalized === undefined) {
        delete story.authorsNote;
        delete story.authorsNoteDepth;
      } else {
        story.authorsNote = normalized;
        if (depth !== undefined) {
          const normalizedDepth = normalizeAuthorsNoteDepth(depth);
          if (normalizedDepth === null) delete story.authorsNoteDepth;
          else story.authorsNoteDepth = normalizedDepth;
        }
      }
      story.updatedAt = EDITED;
      return payloadFrom(story);
    },
    setAuthorBrief(authorBrief) {
      const normalized = authorBrief.trim().length === 0 ? undefined : authorBrief;
      if (normalized === undefined) delete story.authorBrief;
      else story.authorBrief = normalized;
      story.updatedAt = EDITED;
      return payloadFrom(story);
    },
    setFactsBudget(budgetTokens) {
      if (budgetTokens === null) delete story.factsBudgetTokens;
      else story.factsBudgetTokens = budgetTokens;
      story.updatedAt = EDITED;
      return payloadFrom(story);
    },
    setPhraseBias(phraseBias) {
      if (phraseBias.length === 0) delete story.phraseBias;
      else story.phraseBias = phraseBias.map((entry) => ({ ...entry }));
      story.updatedAt = EDITED;
      return payloadFrom(story);
    },
    setBannedStrings(bannedStrings) {
      if (bannedStrings.length === 0) delete story.bannedStrings;
      else story.bannedStrings = [...bannedStrings];
      story.updatedAt = EDITED;
      return payloadFrom(story);
    },
    deleteStory() {
      story = { id: "demo-empty", title: "Untitled", createdAt: CREATED, updatedAt: CREATED,
        nodes: [], activeRootId: null, recentNodeIds: [], tags: [], facts: [], chapterBreaks: [] };
      return payloadFrom(story);
    },
    autonameStory() { story.title = "the compass at sorrow cliff"; return payloadFrom(story); },
    createFact(input) {
      story.facts.push({
        id: `fact-${story.facts.length + 1}`,
        tag: input.tag ?? null,
        text: input.text,
        activation: input.activation ?? "always",
        keys: input.keys === undefined ? [] : [...input.keys],
        createdAt: CREATED,
        updatedAt: CREATED,
        ...factMetadataOverrides({
          secondaryKeys: input.secondaryKeys ?? [],
          secondaryMode: input.secondaryMode ?? "and",
          scanDepth: input.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
          recursion: input.recursion ?? "on",
          priority: input.priority ?? "normal"
        }),
        ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens })
      });
      return payloadFrom(story);
    },
    patchFact(id, input) {
      const fact = story.facts.find((candidate) => candidate.id === id);
      if (fact === undefined) throw new Error(`Unknown demo fact: ${id}`);
      if (input.tag !== undefined) fact.tag = input.tag;
      if (input.text !== undefined) fact.text = input.text;
      if (input.activation !== undefined) fact.activation = input.activation;
      if (input.keys !== undefined) fact.keys = [...input.keys];
      if (input.secondaryKeys !== undefined) {
        if (input.secondaryKeys === null || input.secondaryKeys.length === 0) {
          delete fact.secondaryKeys;
        } else {
          fact.secondaryKeys = [...input.secondaryKeys];
        }
      }
      if (input.secondaryMode !== undefined) {
        if (input.secondaryMode === null || input.secondaryMode === "and") {
          delete fact.secondaryMode;
        } else {
          fact.secondaryMode = input.secondaryMode;
        }
      }
      if (input.scanDepth !== undefined) {
        if (input.scanDepth === null) delete fact.scanDepth;
        else if (input.scanDepth === DEFAULT_FACT_SCAN_PARTS) delete fact.scanDepth;
        else fact.scanDepth = input.scanDepth;
      }
      if (input.recursion !== undefined) {
        if (input.recursion === null || input.recursion === "on") {
          delete fact.recursion;
        } else {
          fact.recursion = input.recursion;
        }
      }
      if (input.priority !== undefined) {
        if (input.priority === "normal") delete fact.priority;
        else fact.priority = input.priority;
      }
      if (input.budgetTokens !== undefined) {
        if (input.budgetTokens === null) delete fact.budgetTokens;
        else fact.budgetTokens = input.budgetTokens;
      }
      normalizeDemoFactMetadata(fact);
      fact.updatedAt = CREATED;
      return payloadFrom(story);
    },
    deleteFact(id) { story.facts = story.facts.filter((fact) => fact.id !== id); return payloadFrom(story); },
    reorderFact(id, toIndex) {
      const from = story.facts.findIndex((fact) => fact.id === id);
      if (from === -1) throw new Error(`Unknown demo fact: ${id}`);
      const clamped = Math.max(0, Math.min(toIndex, story.facts.length - 1));
      const [fact] = story.facts.splice(from, 1);
      story.facts.splice(clamped, 0, fact!);
      return payloadFrom(story);
    },
    createChapterBreak(parentPartId, title = "") {
      const breakId = createDemoChapterBreak(story, parentPartId, title, CREATED);
      return { payload: payloadFrom(story), breakId };
    },
    renameChapterBreak(breakId, title) {
      if (breakId === null) {
        if (title === "") delete story.firstChapterTitle;
        else story.firstChapterTitle = title;
      } else {
        renameDemoChapterBreak(story, breakId, title);
      }
      return payloadFrom(story);
    },
    removeChapterBreak(breakId) {
      const removed = removeDemoChapterBreak(story, breakId);
      return { payload: payloadFrom(story), removed };
    },
    restoreChapterBreak(breakId, removed) {
      restoreDemoChapterBreak(story, breakId, removed);
      return payloadFrom(story);
    },
    summarizeChapter(breakId) {
      summarizeDemoChapter(story, breakId, CREATED);
      return payloadFrom(story);
    },
    editChapterSummary(summaryId, text) {
      editDemoChapterSummary(story, summaryId, text, EDITED);
      return payloadFrom(story);
    },
    exportMarkdown() { return `# ${story.title}\n\n${activePath(story).map((node) => node.text).join("\n\n")}`; },
    searchStories(request) {
      const query = request.query.trim();
      const response: SearchResponse = {
        query,
        scope: request.scope,
        caseSensitive: request.caseSensitive,
        hits: [],
        capped: false,
        storiesSearched: 0
      };
      if (!searchQueryIsRunnable(query)) return response;
      // The fixture's other stories are the same prose under another title, so
      // vault scope shows a real multi-story grid without a second corpus.
      const others = request.scope === "vault"
        ? listDemoStories().filter((summary) => summary.id !== story.id)
        : [];
      const targets: Story[] = [story, ...others.map((summary) =>
        ({ ...story, id: summary.id, title: summary.title, updatedAt: summary.updatedAt }))];
      const scan = createSearchScan(query, request.caseSensitive);
      for (const target of targets) {
        if (scan.full()) {
          scan.stopEarly();
          break;
        }
        scan.add(buildSearchCorpus(target));
      }
      return { ...response, hits: scan.hits, capped: scan.capped, storiesSearched: scan.storiesSearched };
    }
  };
}

function normalizeDemoFactMetadata(fact: Story["facts"][number]): void {
  const metadata = factMetadataOverrides({
    secondaryKeys: fact.secondaryKeys ?? [],
    secondaryMode: fact.secondaryMode ?? "and",
    scanDepth: fact.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
    recursion: fact.recursion ?? "on",
    priority: fact.priority ?? "normal"
  });
  delete fact.secondaryKeys;
  delete fact.secondaryMode;
  delete fact.scanDepth;
  delete fact.recursion;
  delete fact.priority;
  Object.assign(fact, metadata);
}

function storySummary(story: Story): StorySummary {
  const line = activePath(story);
  const prose = story.nodes.filter((node) => !isChapterSummary(node));
  const leaves = prose.filter((node) => !prose.some((candidate) => candidate.parentId === node.id));
  return { id: story.id, title: story.title, updatedAt: story.updatedAt, partCount: prose.length,
    words: line.reduce((sum, node) => sum + countWords(node.text), 0), forked: story.origin !== undefined, lineCount: leaves.length };
}

function payloadFrom(story: Story): StoryPayload {
  const rollups = computeRollups(story);
  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    ...(story.authorsNote === undefined || story.authorsNote.trim() === ""
      ? {}
      : { authorsNote: story.authorsNote }),
    ...(story.authorsNote === undefined || story.authorsNote.trim() === ""
      || story.authorsNoteDepth === undefined
      ? {}
      : { authorsNoteDepth: story.authorsNoteDepth }),
    ...(story.authorBrief === undefined || story.authorBrief.trim() === ""
      ? {}
      : { authorBrief: story.authorBrief }),
    ...(story.phraseBias === undefined || story.phraseBias.length === 0
      ? {}
      : { phraseBias: story.phraseBias.map((entry) => ({ ...entry })) }),
    ...(story.bannedStrings === undefined || story.bannedStrings.length === 0
      ? {}
      : { bannedStrings: [...story.bannedStrings] }),
    ...(story.firstChapterTitle === undefined || story.firstChapterTitle === ""
      ? {}
      : { firstChapterTitle: story.firstChapterTitle }),
    ...(story.factsBudgetTokens === undefined ? {} : { factsBudgetTokens: story.factsBudgetTokens }),
    nodes: story.nodes.map((node): NodeStub => {
      const rollup = rollups.get(node.id)!;
      const base = {
        id: node.id,
        parentId: node.parentId,
        preview: nodeStubPreviewText(node.text),
        words: countWords(node.text),
        tokens: estimateTokens(node.text),
        childCount: rollup.childCount,
        leafCount: rollup.leafCount,
        lastTouched: rollup.lastTouched,
        hasInstruction: nodeStubHasInstruction(node.instruction),
        activeChildId: node.activeChildId
      };
      if (node.chapterBreakId !== undefined) return {
        ...base,
        role: "summary",
        text: node.text,
        instruction: node.instruction,
        chapterBreakId: node.chapterBreakId,
        coveredExtent: node.coveredExtent === undefined ? undefined : { ...node.coveredExtent },
        madeAt: node.madeAt,
        ...(node.editedByUser === true ? { editedByUser: true as const } : {})
      };
      return { ...base, ...(node.role === undefined ? {} : { role: node.role }) };
    }),
    path: activePath(story).map((node) => structuredClone(node)),
    activeRootId: story.activeRootId,
    tags: story.tags.map((tag) => ({ ...tag })),
    recentNodeIds: [...story.recentNodeIds],
    facts: story.facts.map((fact) => ({ ...fact })),
    chapterBreaks: story.chapterBreaks.map((chapterBreak) => ({ ...chapterBreak }))
  };
}

export const DEMO_SETTINGS: GenerationSettings = {
  provider: "dry-run", baseUrl: "", model: "qwen3-32b", apiKeyEnv: null,
  temperature: 0.7, maxTokens: 2_048, systemPrompt: "Continue the story in its established voice.", contextWindow: 32_768
};

export const DEMO_SETTINGS_DOCUMENT: SettingsDocumentV2 = {
  schemaVersion: 2,
  connections: {
    demo: {
      name: "Dry Run",
      preset: "dry-run",
      protocol: "dry-run",
      baseUrl: null,
      auth: { type: "none" },
      headers: [],
      timeouts: { responseHeaderMs: 1_000, firstTokenMs: 1_000, idleMs: 1_000, totalMs: 5_000 }
    }
  },
  models: {
    demo: {
      connectionId: "demo",
      remoteId: "dry-run",
      name: "Dry Run",
      discovered: { contextWindow: 32_768 },
      overrides: {},
      capabilities: {
        temperature: "supported",
        assistantPrefill: "unsupported",
        reasoningEffort: "unsupported",
        promptCaching: "unsupported"
      }
    }
  },
  profiles: {
    default: {
      name: "Default",
      modelId: "demo",
      temperature: DEMO_SETTINGS.temperature,
      maxOutputTokens: DEMO_SETTINGS.maxTokens,
      effort: "default",
      cachePolicy: "off"
    }
  },
  routing: { default: "default" },
  writing: { defaultAuthorBrief: DEMO_SETTINGS.systemPrompt }
};

export const DEMO_SETTINGS_VIEW: SettingsView = {
  dataFormat: 2,
  editable: true,
  stateGeneration: 1,
  activeRevision: 1,
  pendingRevision: null,
  document: DEMO_SETTINGS_DOCUMENT,
  effective: DEMO_SETTINGS,
  effectiveProse: DEMO_SETTINGS,
  lastActivationOutcome: null
};

/** The demo fixture behind the same StoryApi the live server speaks — the app
 *  never branches on which backend it has. Streaming methods honor abort with
 *  the server's invariant: an aborted stream never commits. */
export function demoStoryApi(demo: DemoController): StoryApi {
  const unavailable = (feature: string) => { throw new Error(`${feature} is not available in the demo fixture`); };
  let settingsView = structuredClone(DEMO_SETTINGS_VIEW);
  return {
    listStories: async () => demo.listStories(),
    createStory: async () => demo.createStory(),
    loadStory: async (id) => demo.openStory(id),
    renameStory: async (_id, title) => demo.renameStory(title),
    setAuthorsNote: async (_storyId, authorsNote, depth) => demo.setAuthorsNote(authorsNote, depth),
    setAuthorBrief: async (_storyId, authorBrief) => demo.setAuthorBrief(authorBrief),
    setFactsBudget: async (_storyId, budgetTokens) => demo.setFactsBudget(budgetTokens),
    setPhraseBias: async (_storyId, phraseBias) => demo.setPhraseBias(phraseBias),
    setBannedStrings: async (_storyId, bannedStrings) => demo.setBannedStrings(bannedStrings),
    autonameStory: async () => demo.autonameStory(),
    acknowledgeUnknownOutcomes: async () => demo.autonameStory(),
    deleteStory: async () => { demo.deleteStory(); return { ok: true }; },
    getTokenProbabilities: async () => unavailable("Token probabilities"),
    getGenerationRecords: async () => [],
    getGenerationRecord: async () => unavailable("Generation records"),
    getReasoning: async () => unavailable("A thought"),
    stageStoryImage: async () => unavailable("Image staging"),
    releaseStoryImage: async () => unavailable("Image release"),
    switchLine: async (_storyId, nodeId, options = {}) => demo.switchTo(nodeId, options),
    createNode: async (_storyId, body) => {
      if (body.appendTo !== undefined) {
        return demo.appendGenerated(body.instruction ?? "", body.text, true, body.genId);
      }
      if (body.sourceNodeId !== undefined) {
        // Edit-as-sibling: never copy or invent genId.
        return demo.createEditedTake(body.sourceNodeId, body.instruction ?? "", body.text);
      }
      // Stopped provider commit carries genId; human write omits it.
      return demo.createChild(
        body.parentId ?? null,
        body.instruction ?? "",
        body.text,
        body.genId === undefined,
        body.genId
      );
    },
    editNode: async (_storyId, node, patch) => demo.editNode(node.id, patch),
    deleteNode: async (_storyId, nodeId, expectedSubtreeCount) => demo.deleteNode(nodeId, expectedSubtreeCount),
    pruneUnusedTakes: async (_storyId, expected) => demo.pruneUnusedTakes(expected),
    takeFromCut: async () => unavailable("Take from cut"),
    pasteStoryLine: async () => unavailable("Paste story line"),
    putBookmark: async (_storyId, nodeId, name, label) => demo.putBookmark(nodeId, name, label),
    deleteBookmark: async (_storyId, nodeId) => demo.deleteBookmark(nodeId),
    createFact: async (_storyId, body) => {
      const inputs = "facts" in body ? body.facts : [body];
      let payload = demo.payload();
      for (const fact of inputs) payload = demo.createFact(fact);
      return payload;
    },
    patchFact: async (_storyId, factId, body) => demo.patchFact(factId, body),
    deleteFact: async (_storyId, factId) => demo.deleteFact(factId),
    reorderFact: async (_storyId, factId, toIndex) => demo.reorderFact(factId, toIndex),
    createChapterBreak: async (_storyId, parentPartId, title = "") => demo.createChapterBreak(parentPartId, title),
    renameChapterBreak: async (_storyId, breakId, title) => demo.renameChapterBreak(breakId, title),
    removeChapterBreak: async (_storyId, breakId) => demo.removeChapterBreak(breakId),
    restoreChapterBreak: async (_storyId, breakId, removed) => demo.restoreChapterBreak(breakId, removed),
    summarizeChapter: async (_storyId, breakId) => demo.summarizeChapter(breakId),
    editChapterSummary: async (_storyId, summaryId, text) => demo.editChapterSummary(summaryId, text),
    getSettings: async () => structuredClone(settingsView),
    saveSettings: async (command) => {
      const effective = basicSettingsFromDocument(command.document);
      const effectiveProse = basicSettingsFromDocument(
        command.document,
        selectSettingsRoute(command.document, "prose").profileId
      );
      settingsView = {
        dataFormat: 2,
        editable: true,
        stateGeneration: settingsView.dataFormat === 2 ? settingsView.stateGeneration + 1 : 1,
        activeRevision: settingsView.dataFormat === 2 ? settingsView.activeRevision + 1 : 1,
        pendingRevision: null,
        document: command.document,
        effective,
        effectiveProse,
        lastActivationOutcome: null
      };
      return settingsMutationResult(settingsView);
    },
    discardPendingSettings: async () => {
      if (settingsView.dataFormat !== 2) throw new Error("Legacy demo settings are read-only.");
      settingsView = {
        ...settingsView,
        stateGeneration: settingsView.stateGeneration + 1,
        pendingRevision: null
      };
      return settingsMutationResult(settingsView);
    },
    checkModelServer: async () => ({ state: "ready", message: "dry-run model server is ready" }),
    probeContextWindow: async () => ({ contextWindow: DEMO_SETTINGS.contextWindow }),
    resolveSamplingBias: async (request) => demoResolveSamplingBias(request),
    // The demo has no provider behind it, so there is never a tokenize source.
    countPromptTokens: async () => ({ kind: "estimate", reason: "no-source" }),
    discoverModels: async (): Promise<ModelDiscoveryResultV2> => ({
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [
        {
          remoteId: "gpt-5.4",
          name: "GPT-5.4",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          source: "openai-models"
        },
        {
          remoteId: "gpt-5-mini",
          name: "GPT-5 mini",
          contextWindow: 400_000,
          maxOutputTokens: 128_000,
          source: "openai-models"
        }
      ]
    }),
    importSillyTavern: async () => unavailable("SillyTavern import"),
    importMarkdown: async () => unavailable("Markdown import"),
    importNovelAI: async () => unavailable("NovelAI import"),
    importScenario: async () => unavailable("NovelAI scenario import"),
    importLorebook: async () => unavailable("NovelAI Lorebook import"),
    importCard: async (_storyId, cardBytes) => {
      const room = MAX_FACTS - demo.payload().facts.length;
      const plan = planCardImport(cardBytes, room);
      let payload = demo.payload();
      for (const fact of plan.facts) payload = demo.createFact(fact);
      return { payload, plan };
    },
    exportMarkdown: async () => demo.exportMarkdown(),
    searchStories: async (search, signal) => {
      // The fixture answers instantly, so the only cancellation it can honour
      // is one that arrived before the call.
      if (signal?.aborted === true) throw new Error("Search was superseded or cancelled");
      return demo.searchStories(search);
    },
    // The fixture delivers every delta synchronously through `onDelta`
    // before it observes the abort, so it has no late text for `onStopped`.
    continueStory: async (_storyId, instruction, genId, target, onDelta, signal) => {
      const text = target.appendTo !== undefined ? DEMO_CONTINUE_TEXT : DEMO_GENERATED_TEXT;
      let landed = "";
      for await (const delta of streamFake(text, { wpm: 700, signal })) {
        landed += delta;
        onDelta(delta);
      }
      if (signal.aborted) return null;
      // The fixture has no real context window to press against, so it never
      // sheds a Fact — droppedFacts is honestly empty rather than simulated.
      const payload = target.appendTo !== undefined
        ? demo.appendGenerated(instruction, landed, true, genId)
        : demo.createChild(target.parentId ?? null, instruction, landed, false, genId);
      return { payload, droppedFacts: [] };
    },
    rewriteNode: async (_storyId, nodeId, body, onDelta, signal, onCommitted) => {
      let landed = "";
      for await (const delta of streamFake(DEMO_REWRITE_TEXT, { wpm: 700, signal })) {
        landed += delta;
        onDelta(delta);
      }
      if (signal.aborted) return null;
      const node = demo.payload().path.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return null;
      const result = demo.rewriteNode(nodeId, body.start, body.end, landed, body.destination);
      // Mirrors the real adapters: the fixture's own "commit" already
      // happened above, so tell the caller before returning rather than
      // pretend it waits on some refresh of its own.
      onCommitted?.(result.nodeId);
      return result.nodeId;
    },
    // The demo fixture stashes no partials; a settle after a stop reports
    // nothing committed, the same shape a restarted backend gives.
    commitPartialRewrite: async () => null,
    createSummaryTake: async (_storyId, _body, onDelta, signal) => {
      let landed = "";
      for await (const delta of streamFake(DEMO_SUMMARY_TEXT, { wpm: 700, signal })) {
        landed += delta;
        onDelta(delta);
      }
      if (signal.aborted) return null;
      const payload = demo.addSummaryTake(landed);
      const nodeId = payload.path.at(-1)?.id;
      // The demo fixture always summarizes the whole requested prefix, so it
      // never has an earlier point to report.
      return nodeId === undefined ? null : { nodeId, narrowedTo: null };
    }
  };
}

function settingsMutationResult(view: Extract<SettingsView, { dataFormat: 2 }>): SettingsMutationResult {
  return {
    kind: "settings",
    settingsStateGeneration: view.stateGeneration,
    activeSettingsRevision: view.activeRevision,
    pendingSettingsRevision: view.pendingRevision,
    activationOutcome: view.lastActivationOutcome
  };
}

/** A complete AppSource over the in-memory fixture — the single demo entry
 *  point for main.ts and tests. */
export function demoAppSource(dense = false): AppSource {
  const demo = createDemoController(dense);
  const settingsView = structuredClone(DEMO_SETTINGS_VIEW);
  return {
    payload: demo.payload(),
    api: demoStoryApi(demo),
    demo: true,
    stories: demo.listStories(),
    settingsView,
    settings: settingsView.effective,
    storyFolder: "",
    exportDirectory: process.cwd(),
    connection: null,
    // The fixture answers from memory, so there is no burst to collapse and
    // nothing to protect by waiting. It also keeps `renderOnce` deterministic:
    // that path sends its keys and captures the frame at once, so a scan that
    // had not started yet would be captured for ever as `searching…`.
    searchDebounceMs: 0,
    config: normalizeUserConfig({ updates: { mode: "notify" } }),
    readingPositions: {}
  };
}

function tagColor(label: TagStatus): string {
  if (label === "Canon") return "#E3B341";
  if (label === "Alt") return "#C49AC4";
  if (label === "Draft") return "#9FB6C4";
  if (label === "Discarded") return "#7A7166";
  return "#C8933F";
}
