import {
  MAX_FACT_TEXT_CHARS,
  type HumanEditAttribution,
  type Story,
  type StoryFact,
  type StoryNode
} from "../shared/types.js";
import { activePath } from "../shared/story-tree.js";
import { countWords } from "../shared/story-text.js";
import {
  STORY_FORMAT,
  STORY_SCHEMA_VERSION,
  StoryFormatError,
  parseManifest,
  serializeManifest,
  validateNodeAttribution,
  type ObjectHash,
  type StoredFactV1,
  type StoredNodeV1,
  type StoryManifestV5,
  type TextRevisionV1
} from "./story-format.js";
import { cloneAttribution } from "./story-format-nodes.js";
import { createStoryReadCache, StoryObjectStore } from "./story-objects.js";
import {
  attachStoredNodeText,
  hydrateStoredNodeText,
  isNodeTextHydrated,
  nodeRewriteId,
  nodeStubPreview,
  nodeStubTokens,
  nodeStubWords,
  reusableStoredRevisionId
} from "./story-node-text.js";
import { reusableRevisionId, type StoryRevisionSnapshot } from "./story-snapshot.js";
import { setStoryAutonameId, storyAutonameId } from "./story-metadata.js";

export interface DecodedStoryBundle {
  story: Story;
  revisions: ReadonlyMap<ObjectHash, TextRevisionV1>;
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
  validateFactBodies(story.facts);
  for (const node of story.nodes) if (isNodeTextHydrated(node)) validateNodeAttribution(node);
  await objects.init();
  const revisionIds: Array<ObjectHash | undefined> = story.nodes.map((node) =>
    reusableStoredRevisionId(node) ?? reusableRevisionId(snapshot, node.id, node.text)
  );
  const missing = story.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ index }) => revisionIds[index] === undefined);
  const stored = await objects.storeTexts(missing.map(({ node }) => node.text), reuseFrom);
  for (const [index, entry] of missing.entries()) revisionIds[entry.index] = stored[index]!;

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
    ...(node.attribution === undefined ? {} : { attribution: cloneAttribution(node.attribution) }),
    activeChildId: node.activeChildId
  }));
  const factRevisionIds = await objects.storeTexts(story.facts.map((fact) => fact.text), reuseFrom);
  const facts: StoredFactV1[] = story.facts.map((fact, index) => ({
    id: fact.id,
    tag: fact.tag,
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
    ...(storyAutonameId(story) === undefined ? {} : { autonameId: storyAutonameId(story) }),
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
      ...(stored.human === undefined ? {} : { human: stored.human }),
      ...(stored.genId === undefined ? {} : { genId: stored.genId }),
      ...(stored.role === undefined ? {} : { role: stored.role }),
      ...(stored.chapterBreakId === undefined ? {} : { chapterBreakId: stored.chapterBreakId }),
      ...(stored.coveredExtent === undefined ? {} : { coveredExtent: { ...stored.coveredExtent } }),
      ...(stored.madeAt === undefined ? {} : { madeAt: stored.madeAt }),
      ...(stored.editedByUser === undefined ? {} : { editedByUser: stored.editedByUser }),
      activeChildId: stored.activeChildId
    };
    attachStoredNodeText(node, stored, text);
    if (text !== null) validateNodeAttribution(node);
    return node;
  });
  let cursor = revisionNodes.length;
  const facts: StoryFact[] = manifest.facts.map((stored) => ({
    id: stored.id,
    tag: stored.tag,
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
  return { story, revisions: cache.revisions };
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
  }
}

export { countWords } from "../shared/story-text.js";

function requireEncodedRevision(value: ObjectHash | undefined, nodeId: string): ObjectHash {
  if (value === undefined) throw new StoryFormatError(`Missing encoded revision for node: ${nodeId}`);
  return value;
}

function validateFactBodies(facts: readonly StoryFact[]): void {
  for (const fact of facts) {
    if (fact.text.trim().length === 0) throw new StoryFormatError(`Fact ${fact.id} text must not be empty`);
    if (fact.text.length > MAX_FACT_TEXT_CHARS) {
      throw new StoryFormatError(`Fact ${fact.id} exceeds the ${MAX_FACT_TEXT_CHARS.toLocaleString()}-character limit`);
    }
  }
}
