import {
  MAX_FACT_TEXT_CHARS,
  type HumanEditAttribution,
  type Story,
  type StoryFact,
  type StoryNode
} from "../shared/types.js";
import { MAX_AUTHORS_NOTE_CHARS, storedAuthorsNoteDepth } from "../shared/authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS, storedAuthorBrief } from "../shared/author-brief.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  FactActivationError,
  factMetadataOverrides
} from "../shared/fact-metadata.js";
import { parseFactMetadata } from "../shared/fact-validation.js";
import { factTextWithinLimit } from "../shared/fact-limits.js";
import { activePath } from "../shared/story-tree.js";
import { countWords } from "../shared/story-text.js";
import {
  STORY_FORMAT,
  STORY_SCHEMA_VERSION,
  StoryFormatError,
  optionalBannedStrings,
  optionalPhraseBias,
  parseManifest,
  serializeManifest,
  validateNodeAttribution,
  validateNodeRewrittenSpans,
  type ObjectHash,
  type StoredFactV1,
  type StoredNodeV1,
  type StoryManifestV5,
  type TextRevisionV1
} from "./story-format.js";
import { cloneAttribution, cloneRewrittenSpans } from "./story-format-nodes.js";
import { createStoryReadCache, StoryObjectStore } from "./story-objects.js";
import {
  attachStoredNodeText,
  hydrateStoredNodeText,
  isNodeTextHydrated,
  nodeRewriteId,
  nodeStubPreview,
  nodeStubTokens,
  nodeStubWords,
  reusableStoredRevisionId,
  reusableReasoningId,
  reusableTokenProbabilityId
} from "./story-node-text.js";
import { takePendingTokenProbabilities } from "./story-node-token-probabilities.js";
import { takePendingReasoning } from "./story-node-reasoning.js";
import { reusableRevisionId, type StoryRevisionSnapshot } from "./story-snapshot.js";
import { setStoryAutonameId, storyAutonameId } from "./story-metadata.js";
import { boundedString } from "./story-wire-validation.js";

export interface DecodedStoryBundle {
  story: Story;
  /** Live view of the decode cache's hash-verified revisions: the same map
   * keeps growing while `hydrateStoryNodes` reads more of the committed
   * graph. Callers depend on that aliasing — the aggregate session adopts it
   * at prepare time so hydrated-late nodes stay verified — so it must not be
   * snapshotted into a copy. */
  liveRevisions: ReadonlyMap<ObjectHash, TextRevisionV1>;
}

interface StoryBundleState {
  objects: StoryObjectStore;
  cache: ReturnType<typeof createStoryReadCache>;
  nodesById: ReadonlyMap<string, StoryNode>;
  storedById: ReadonlyMap<string, StoredNodeV1>;
}

const storyBundles = new WeakMap<Story, StoryBundleState>();

export async function encodeStoryBundle(
  story: Story,
  objects: StoryObjectStore,
  reuseFrom?: StoryObjectStore,
  snapshot?: StoryRevisionSnapshot
): Promise<StoryManifestV5> {
  const authorsNote = story.authorsNote === undefined || story.authorsNote === ""
    ? undefined
    : boundedString(story.authorsNote, "story.authorsNote", MAX_AUTHORS_NOTE_CHARS);
  const authorsNoteDepth = storedAuthorsNoteDepth(authorsNote, story.authorsNoteDepth);
  const canonicalBrief = storedAuthorBrief(story.authorBrief);
  const authorBrief = canonicalBrief === undefined
    ? undefined
    : boundedString(canonicalBrief, "story.authorBrief", MAX_AUTHOR_BRIEF_CHARS);
  const phraseBias = optionalPhraseBias(story.phraseBias);
  const bannedStrings = optionalBannedStrings(story.bannedStrings);
  validateFactBodies(story.facts);
  for (const node of story.nodes) if (isNodeTextHydrated(node)) {
    validateNodeAttribution(node);
    validateNodeRewrittenSpans(node);
  }
  await objects.init();
  const revisionIds: Array<ObjectHash | undefined> = story.nodes.map((node) =>
    reusableStoredRevisionId(node) ?? reusableRevisionId(snapshot, node.id, node.text)
  );
  const missing = story.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ index }) => revisionIds[index] === undefined);
  const stored = await objects.storeTexts(missing.map(({ node }) => node.text), reuseFrom);
  for (const [index, entry] of missing.entries()) revisionIds[entry.index] = stored[index]!;

  // At most one node per encode ever carries a pending record — the take a
  // continuation just committed, if it captured any — so a plain sequential
  // pass costs nothing extra; every other node resolves synchronously from
  // reusableTokenProbabilityId. takePendingTokenProbabilities also clears the
  // side table, so a later encode of the same long-lived Story never stores
  // the same record twice.
  const tokenProbabilityIds: Array<ObjectHash | undefined> = [];
  for (const node of story.nodes) {
    const pending = takePendingTokenProbabilities(node);
    tokenProbabilityIds.push(
      pending === undefined
        ? reusableTokenProbabilityId(node)
        : await objects.storeTokenProbabilities(pending, reuseFrom)
    );
  }

  // Same reasoning as the token-probabilities loop above: at most one node
  // per encode ever carries a pending reasoning record, so a plain
  // sequential pass costs nothing extra.
  const reasoningIds: Array<ObjectHash | undefined> = [];
  for (const node of story.nodes) {
    const pending = takePendingReasoning(node);
    reasoningIds.push(
      pending === undefined
        ? reusableReasoningId(node)
        : await objects.storeReasoning(pending, reuseFrom)
    );
  }

  const nodes: StoredNodeV1[] = story.nodes.map((node, index) => ({
    id: node.id,
    parentId: node.parentId,
    instruction: node.instruction,
    model: node.model,
    createdAt: node.createdAt,
    preview: nodeStubPreview(node),
    words: nodeStubWords(node),
    tokens: nodeStubTokens(node),
    ...(node.updatedAt === undefined ? {} : { updatedAt: node.updatedAt }),
    ...(node.genId === undefined ? {} : { genId: node.genId }),
    ...(nodeRewriteId(node) === undefined ? {} : { rewriteId: nodeRewriteId(node) }),
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.chapterBreakId === undefined ? {} : { chapterBreakId: node.chapterBreakId }),
    ...(node.coveredExtent === undefined ? {} : { coveredExtent: { ...node.coveredExtent } }),
    ...(node.madeAt === undefined ? {} : { madeAt: node.madeAt }),
    ...(node.editedByUser === undefined ? {} : { editedByUser: node.editedByUser }),
    ...(node.human === undefined ? {} : { human: node.human }),
    revisionId: requireEncodedRevision(revisionIds[index], node.id),
    ...(tokenProbabilityIds[index] === undefined ? {} : { tokenProbabilityId: tokenProbabilityIds[index] }),
    ...(reasoningIds[index] === undefined ? {} : { reasoningId: reasoningIds[index] }),
    ...(node.attribution === undefined ? {} : { attribution: cloneAttribution(node.attribution) }),
    ...(node.rewrittenSpans === undefined ? {} : { rewrittenSpans: cloneRewrittenSpans(node.rewrittenSpans) }),
    activeChildId: node.activeChildId
  }));
  const factRevisionIds = await objects.storeTexts(story.facts.map((fact) => fact.text), reuseFrom);
  const facts: StoredFactV1[] = story.facts.map((fact, index) => ({
    id: fact.id,
    tag: fact.tag,
    ...(fact.activation === "always" ? {} : { activation: fact.activation }),
    ...(fact.keys.length === 0 ? {} : { keys: [...fact.keys] }),
    ...factMetadataOverrides({
      secondaryKeys: fact.secondaryKeys ?? [],
      secondaryMode: fact.secondaryMode ?? "and",
      scanDepth: fact.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
      recursion: fact.recursion ?? "on",
      priority: fact.priority ?? "normal"
    }),
    ...(fact.budgetTokens === undefined ? {} : { budgetTokens: fact.budgetTokens }),
    revisionId: factRevisionIds[index]!,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    ...(fact.sourcePartId === undefined ? {} : { sourcePartId: fact.sourcePartId })
  }));
  const manifest: StoryManifestV5 = {
    format: STORY_FORMAT,
    schemaVersion: STORY_SCHEMA_VERSION,
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    ...(story.origin === undefined ? {} : { origin: { ...story.origin } }),
    ...(authorsNote === undefined ? {} : { authorsNote }),
    ...(authorsNoteDepth === undefined ? {} : { authorsNoteDepth }),
    ...(authorBrief === undefined ? {} : { authorBrief }),
    ...(phraseBias === undefined || phraseBias.length === 0 ? {} : { phraseBias }),
    ...(bannedStrings === undefined || bannedStrings.length === 0 ? {} : { bannedStrings }),
    ...(storyAutonameId(story) === undefined ? {} : { autonameId: storyAutonameId(story) }),
    ...(story.firstChapterTitle === undefined || story.firstChapterTitle === ""
      ? {}
      : { firstChapterTitle: story.firstChapterTitle }),
    ...(story.factsBudgetTokens === undefined ? {} : { factsBudgetTokens: story.factsBudgetTokens }),
    activeWordCount: activePath(story).reduce((sum, node) => sum + nodeStubWords(node), 0),
    nodes,
    facts,
    activeRootId: story.activeRootId,
    // In memory a tag has `status`; on disk the key is `label`. See StoredTagV1.
    bookmarks: story.tags.map((tag) => ({
      nodeId: tag.nodeId,
      name: tag.name,
      label: tag.status,
      color: tag.color,
      createdAt: tag.createdAt
    })),
    recentNodeIds: [...story.recentNodeIds],
    chapterBreaks: story.chapterBreaks.map((chapterBreak) => ({ ...chapterBreak }))
  };
  return parseManifest(serializeManifest(manifest), story.id);
}

export async function decodeStoryBundle(
  manifest: StoryManifestV5,
  bundleDir: string,
  options: { activeOnly?: boolean } = {}
): Promise<DecodedStoryBundle> {
  const objects = new StoryObjectStore(bundleDir);
  const cache = createStoryReadCache();
  const hasStoredStubs = manifest.nodes.every(
    (node) => node.preview !== undefined && node.words !== undefined && node.tokens !== undefined
  );
  const wanted = options.activeOnly === true && hasStoredStubs
    ? new Set([
        ...activePath(manifest).map((node) => node.id),
        ...manifest.nodes.filter((node) => node.chapterBreakId !== undefined).map((node) => node.id)
      ])
    : new Set(manifest.nodes.map((node) => node.id));
  const storedToRead = manifest.nodes.filter((node) => wanted.has(node.id));
  const revisionNodes = storedToRead.filter((node) => node.syntheticEmpty !== true);
  const texts = await objects.readTexts([
    ...revisionNodes.map((node) => node.revisionId),
    ...manifest.facts.map((fact) => fact.revisionId)
  ], cache);
  const textById = new Map(revisionNodes.map((stored, index) => [stored.id, texts[index]!] as const));
  const nodes: StoryNode[] = manifest.nodes.map((stored) => {
    const text = stored.syntheticEmpty === true ? "" : textById.get(stored.id) ?? null;
    const node: StoryNode = {
      id: stored.id,
      parentId: stored.parentId,
      instruction: stored.instruction,
      text: text ?? "",
      model: stored.model,
      createdAt: stored.createdAt,
      ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
      ...(stored.attribution === undefined ? {} : { attribution: cloneAttribution(stored.attribution) }),
      ...(stored.rewrittenSpans === undefined ? {} : { rewrittenSpans: cloneRewrittenSpans(stored.rewrittenSpans) }),
      ...(stored.human === undefined ? {} : { human: stored.human }),
      ...(stored.genId === undefined ? {} : { genId: stored.genId }),
      ...(stored.role === undefined ? {} : { role: stored.role }),
      ...(stored.chapterBreakId === undefined ? {} : { chapterBreakId: stored.chapterBreakId }),
      ...(stored.coveredExtent === undefined ? {} : { coveredExtent: { ...stored.coveredExtent } }),
      ...(stored.madeAt === undefined ? {} : { madeAt: stored.madeAt }),
      ...(stored.editedByUser === undefined ? {} : { editedByUser: stored.editedByUser }),
      // Presence only — the record itself is fetched on demand, never loaded
      // with the story. See shared/token-probabilities.ts.
      ...(stored.tokenProbabilityId === undefined ? {} : { tokenProbabilities: true as const }),
      // Presence only, mirroring tokenProbabilities above. See
      // shared/reasoning.ts.
      ...(stored.reasoningId === undefined ? {} : { reasoning: true as const }),
      activeChildId: stored.activeChildId
    };
    attachStoredNodeText(node, stored, text);
    if (text !== null) {
      validateNodeAttribution(node);
      validateNodeRewrittenSpans(node);
    }
    return node;
  });
  let cursor = revisionNodes.length;
  const facts: StoryFact[] = manifest.facts.map((stored) => ({
    id: stored.id,
    tag: stored.tag,
    activation: stored.activation ?? "always",
    keys: stored.keys === undefined ? [] : [...stored.keys],
    ...factMetadataOverrides({
      secondaryKeys: stored.secondaryKeys ?? [],
      secondaryMode: stored.secondaryMode ?? "and",
      scanDepth: stored.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
      recursion: stored.recursion ?? "on",
      priority: stored.priority ?? "normal"
    }),
    ...(stored.budgetTokens === undefined ? {} : { budgetTokens: stored.budgetTokens }),
    text: texts[cursor++]!,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.sourcePartId === undefined ? {} : { sourcePartId: stored.sourcePartId })
  }));
  validateFactBodies(facts);
  const story: Story = {
    id: manifest.id,
    title: manifest.title,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.origin === undefined ? {} : { origin: { ...manifest.origin } }),
    ...(manifest.authorsNote === undefined || manifest.authorsNote === ""
      ? {}
      : { authorsNote: manifest.authorsNote }),
    ...(storedAuthorsNoteDepth(manifest.authorsNote, manifest.authorsNoteDepth) === undefined
      ? {}
      : { authorsNoteDepth: manifest.authorsNoteDepth }),
    ...(storedAuthorBrief(manifest.authorBrief) === undefined
      ? {}
      : { authorBrief: manifest.authorBrief }),
    ...(manifest.phraseBias === undefined || manifest.phraseBias.length === 0
      ? {}
      : { phraseBias: manifest.phraseBias.map((entry) => ({ ...entry })) }),
    ...(manifest.bannedStrings === undefined || manifest.bannedStrings.length === 0
      ? {}
      : { bannedStrings: [...manifest.bannedStrings] }),
    ...(manifest.firstChapterTitle === undefined
      ? {}
      : { firstChapterTitle: manifest.firstChapterTitle }),
    ...(manifest.factsBudgetTokens === undefined
      ? {}
      : { factsBudgetTokens: manifest.factsBudgetTokens }),
    nodes,
    activeRootId: manifest.activeRootId,
    tags: manifest.bookmarks.map((stored) => ({
      nodeId: stored.nodeId,
      name: stored.name,
      status: stored.label,
      color: stored.color,
      createdAt: stored.createdAt
    })),
    recentNodeIds: [...manifest.recentNodeIds],
    facts,
    chapterBreaks: manifest.chapterBreaks.map((chapterBreak) => ({ ...chapterBreak }))
  };
  setStoryAutonameId(story, manifest.autonameId);
  storyBundles.set(story, {
    objects,
    cache,
    nodesById: new Map(nodes.map((node) => [node.id, node] as const)),
    storedById: new Map(manifest.nodes.map((node) => [node.id, node] as const))
  });
  return { story, liveRevisions: cache.revisions };
}

export async function hydrateStoryNodes(story: Story, nodeIds: readonly string[]): Promise<void> {
  const bundle = storyBundles.get(story);
  if (bundle === undefined) return;
  const targets: Array<{ node: StoryNode; stored: StoredNodeV1 }> = [];
  for (const id of new Set(nodeIds)) {
    const node = bundle.nodesById.get(id) ?? story.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new StoryFormatError(`Unknown story node: ${id}`);
    if (isNodeTextHydrated(node)) continue;
    const stored = bundle.storedById.get(id);
    if (stored === undefined) throw new StoryFormatError(`Unknown stored node: ${id}`);
    targets.push({ node, stored });
  }
  const texts = await bundle.objects.readTexts(targets.map(({ stored }) => stored.revisionId), bundle.cache);
  for (const [index, { node }] of targets.entries()) {
    hydrateStoredNodeText(node, texts[index]!);
    validateNodeAttribution(node);
    validateNodeRewrittenSpans(node);
  }
}

export { countWords } from "../shared/story-text.js";

function requireEncodedRevision(value: ObjectHash | undefined, nodeId: string): ObjectHash {
  if (value === undefined) throw new StoryFormatError(`Missing encoded revision for node: ${nodeId}`);
  return value;
}

function validateFactBodies(facts: readonly StoryFact[]): void {
  for (const fact of facts) {
    try {
      parseFactMetadata(fact, `Fact ${fact.id}`);
    } catch (error) {
      if (error instanceof FactActivationError) throw new StoryFormatError(error.message);
      throw error;
    }
    if (fact.text.trim().length === 0) throw new StoryFormatError(`Fact ${fact.id} text must not be empty`);
    if (!factTextWithinLimit(fact.text)) {
      throw new StoryFormatError(`Fact ${fact.id} exceeds the ${MAX_FACT_TEXT_CHARS.toLocaleString()}-character limit`);
    }
  }
}
