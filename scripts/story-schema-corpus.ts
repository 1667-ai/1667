import { canonicalJson } from "../server/canonical-json.js";

export interface StoryManifestCorpusCase {
  name: string;
  expectedId: string;
  valid: boolean;
  schemaValid: boolean;
  text: string;
}

const NOW = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);
const IMAGE_HASH = "c".repeat(64);
const MUTATION_ID = `m1.1767225600000.${"b".repeat(32)}`;
const ZERO = "00000000000000000000";
const ONE = "00000000000000000001";
const TWO = "00000000000000000002";
const DETERMINISTIC_ID = `st1_${"a".repeat(52)}`;
const NONCANONICAL_DETERMINISTIC_ID = `st1_${"a".repeat(51)}b`;

interface V5Fixture {
  format: "1667-story";
  schemaVersion: 5;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorBrief?: string;
  phraseBias?: Array<Record<string, unknown>>;
  bannedStrings?: string[];
  factsBudgetTokens?: number;
  activeWordCount: number;
  nodes: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  activeRootId: string | null;
  bookmarks: Array<Record<string, unknown>>;
  recentNodeIds: string[];
  chapterBreaks: Array<Record<string, unknown>>;
}

interface LiveFixture {
  format: "1667-story";
  schemaVersion: 6;
  kind: "live";
  id: string;
  revision: string;
  previousManifestHash: string | null;
  content: V5Fixture;
  summary: {
    id: string;
    title: string;
    updatedAt: string;
    partCount: number;
    words: string;
    forked: boolean;
    lineCount: string;
  };
  unresolvedProvider: null | { mutationId: string; fingerprintHash: string };
  lastTransaction: null | { receiptKind: string; mutationId: string; phase: string };
}

interface DeletedFixture {
  format: "1667-story";
  schemaVersion: 6;
  kind: "deleted";
  id: string;
  revision: string;
  previousManifestHash: string;
  deletedAt: string;
  unresolvedProvider: null | { mutationId: string; fingerprintHash: string };
  lastTransaction: { receiptKind: string; mutationId: string; phase: string };
}

/** The successor content payload: every V5Fixture field, one version tag. */
interface V7Fixture extends Omit<V5Fixture, "schemaVersion"> {
  schemaVersion: 7;
}

/** The successor envelope: every LiveFixture field, wrapping a V7Fixture. */
interface Live8Fixture extends Omit<LiveFixture, "schemaVersion" | "content"> {
  schemaVersion: 8;
  content: V7Fixture;
}

function imageAttachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectId: IMAGE_HASH,
    mediaType: "image/png",
    width: 800,
    height: 600,
    byteLength: 123_456,
    ...overrides
  };
}

function v7Manifest(): V7Fixture {
  return { ...v5Manifest(), schemaVersion: 7 };
}

/** A one-node V7 manifest whose root take carries one Image Attachment. It is
 * the successor counterpart of `nodeV5` below, with a real (non-empty)
 * active path so a wrapping V8 envelope's summary can match it. */
function v7ManifestWithImages(): V7Fixture {
  const manifest = v7Manifest();
  manifest.nodes = [{ ...storedNode(), imageAttachments: [imageAttachment()] }];
  manifest.activeRootId = "root";
  return manifest;
}

function live8Manifest(content: V7Fixture): Live8Fixture {
  return {
    format: "1667-story",
    schemaVersion: 8,
    kind: "live",
    id: content.id,
    revision: ONE,
    previousManifestHash: null,
    content,
    summary: {
      id: content.id,
      title: content.title,
      updatedAt: content.updatedAt,
      partCount: content.nodes.length,
      words: ZERO,
      forked: false,
      lineCount: content.nodes.length === 0 ? ZERO : ONE
    },
    unresolvedProvider: null,
    lastTransaction: null
  };
}

export function storyManifestCorpus(): StoryManifestCorpusCase[] {
  const v5 = v5Manifest();
  const live = liveManifest(v5);
  const started = {
    ...live,
    revision: TWO,
    previousManifestHash: HASH,
    unresolvedProvider: { mutationId: MUTATION_ID, fingerprintHash: HASH },
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_ID, phase: "started" }
  };
  const deleted = deletedManifest();
  const nodeV5 = v5Manifest();
  nodeV5.nodes = [storedNode()];
  nodeV5.activeRootId = "root";
  const richV5 = richV5Manifest();
  const deterministicV5 = { ...v5, id: DETERMINISTIC_ID };
  const v7 = v7Manifest();
  const v7WithImages = v7ManifestWithImages();
  const live8Empty = live8Manifest(v7);
  const live8Images = live8Manifest(v7WithImages);

  return [
    valid("v5-minimal", v5.id, `${JSON.stringify(v5, null, 2)}\n`),
    valid("v5-node", nodeV5.id, JSON.stringify(nodeV5)),
    valid("v5-complete-optional-shape", richV5.id, JSON.stringify(richV5)),
    valid("v5-deterministic-story-id", deterministicV5.id, JSON.stringify(deterministicV5)),
    valid("v6-live-revision-1", live.id, canonicalJson(live)),
    valid("v6-live-provider-started", started.id, canonicalJson(started)),
    valid("v6-deleted", deleted.id, canonicalJson(deleted)),
    invalid("v5-unknown-root-key", v5.id, JSON.stringify({ ...v5, surprise: true })),
    invalid("v5-unknown-node-key", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], surprise: true }]
    })),
    invalidNestedV5("v5-unknown-origin-key", richV5, (copy) => {
      copy.origin!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-attribution-key", richV5, (copy) => {
      copy.nodes[0]!.attribution!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-range-key", richV5, (copy) => {
      copy.nodes[0]!.attribution!.ranges[0]!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-rewritten-span-key", richV5, (copy) => {
      copy.nodes[0]!.rewrittenSpans![0]!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-extent-key", richV5, (copy) => {
      copy.nodes[1]!.coveredExtent!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-fact-key", richV5, (copy) => {
      copy.facts[0]!.surprise = true;
    }),
    invalidNestedV5("v5-comma-in-fact-key", richV5, (copy) => {
      copy.facts[0]!.keys = ["red, blue"];
    }),
    invalidNestedV5("v5-invalid-regex-fact-key-flag", richV5, (copy) => {
      copy.facts[0]!.keys = ["/door/d"];
    }),
    invalidNestedV5("v5-invalid-fact-scan-depth", richV5, (copy) => {
      copy.facts[0]!.scanDepth = 0;
    }),
    invalidNestedV5("v5-invalid-fact-secondary-mode", richV5, (copy) => {
      copy.facts[0]!.secondaryMode = "either";
    }),
    invalidNestedV5("v5-invalid-fact-priority", richV5, (copy) => {
      copy.facts[0]!.priority = "urgent";
    }),
    invalidNestedV5("v5-fact-budget-over-bound", richV5, (copy) => {
      copy.facts[0]!.budgetTokens = 0;
    }),
    invalidNestedV5("v5-facts-budget-over-bound", richV5, (copy) => {
      copy.factsBudgetTokens = 0;
    }),
    invalidNestedV5("v5-unknown-phrase-bias-key", richV5, (copy) => {
      copy.phraseBias[0]!.surprise = true;
    }),
    invalidNestedV5("v5-phrase-bias-weight-over-bound", richV5, (copy) => {
      copy.phraseBias[0]!.weight = 101;
    }),
    invalidNestedV5("v5-phrase-bias-empty-phrase", richV5, (copy) => {
      copy.phraseBias[0]!.phrase = "";
    }),
    invalidNestedV5("v5-banned-string-over-bound", richV5, (copy) => {
      copy.bannedStrings = ["x".repeat(65)];
    }),
    invalidNestedV5("v5-duplicate-banned-string", richV5, (copy) => {
      copy.bannedStrings = ["tapestry", "tapestry"];
    }),
    invalidNestedV5("v5-unknown-tag-key", richV5, (copy) => {
      copy.bookmarks[0]!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-chapter-key", richV5, (copy) => {
      copy.chapterBreaks[0]!.surprise = true;
    }),
    invalid("v5-title-over-bound", v5.id, JSON.stringify({ ...v5, title: "x".repeat(4_097) })),
    invalid("v5-authors-note-over-bound", v5.id, JSON.stringify({ ...v5, authorsNote: "x".repeat(4_001) })),
    invalid("v5-authors-note-depth-zero", v5.id, JSON.stringify({ ...v5, authorsNote: "Note.", authorsNoteDepth: 0 })),
    invalid("v5-authors-note-depth-above-max", v5.id, JSON.stringify({ ...v5, authorsNote: "Note.", authorsNoteDepth: 11 })),
    invalid("v5-authors-note-depth-non-integer", v5.id, JSON.stringify({ ...v5, authorsNote: "Note.", authorsNoteDepth: 1.5 })),
    invalid("v5-author-brief-over-bound", v5.id, JSON.stringify({ ...v5, authorBrief: "x".repeat(65_537) })),
    invalid("v5-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, title: "\ud800" }), true),
    invalid("v5-authors-note-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, authorsNote: "\ud800" }), true),
    invalid("v5-author-brief-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, authorBrief: "\ud800" }), true),
    invalid("v5-story-id-final-newline", `${v5.id}\n`, JSON.stringify({ ...v5, id: `${v5.id}\n` })),
    invalid("v5-hash-final-newline", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], revisionId: `${HASH}\n` }]
    })),
    invalid("v5-token-probability-hash-final-newline", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], tokenProbabilityId: `${HASH}\n` }]
    })),
    invalid("v5-generation-record-hash-final-newline", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], generationRecordIds: [`${HASH}\n`] }]
    })),
    invalid("v5-empty-generation-record-ids", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], generationRecordIds: [] }]
    })),
    invalid("v5-noncanonical-deterministic-id", NONCANONICAL_DETERMINISTIC_ID, JSON.stringify({
      ...v5,
      id: NONCANONICAL_DETERMINISTIC_ID
    })),
    invalid("v6-noncanonical-property-order", live.id, JSON.stringify(live), true),
    invalid("v6-trailing-newline", live.id, `${canonicalJson(live)}\n`, true),
    invalid("v6-leading-bom", live.id, `\ufeff${canonicalJson(live)}`),
    invalid("v6-duplicate-root-key", live.id, canonicalJson(live).replace(
      "{",
      '{"format":"1667-story",'
    ), true),
    invalid("v6-unknown-root-key", live.id, canonicalJson({ ...live, surprise: true })),
    invalid("v6-unknown-summary-key", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, surprise: true }
    })),
    invalid("v6-nfd-strings", live.id, canonicalJson({
      ...live,
      content: { ...live.content, title: "Cafe\u0301" },
      summary: { ...live.summary, title: "Cafe\u0301" }
    }), true),
    invalid("v6-unpaired-surrogate", live.id, canonicalJson(live).replaceAll(
      '"title":"Story"',
      '"title":"\\ud800"'
    ), true),
    invalid("v6-summary-mismatch", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, words: ONE }
    }), true),
    invalid("v6-revision-1-with-predecessor", live.id, canonicalJson({
      ...live,
      previousManifestHash: HASH
    })),
    invalid("v6-content-id-mismatch", live.id, canonicalJson({
      ...live,
      content: { ...live.content, id: "other-story" }
    }), true),
    invalid("v6-uint64-overflow", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, words: "18446744073709551616" }
    })),
    invalid("v6-invalid-time", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, updatedAt: "2026-02-30T00:00:00.000Z" }
    }), true),
    invalid("v6-time-final-newline", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, updatedAt: `${NOW}\n` }
    })),
    invalid("v6-uint-final-newline", live.id, canonicalJson({
      ...live,
      summary: { ...live.summary, words: `${ZERO}\n` }
    })),
    invalid("v6-hash-final-newline", live.id, canonicalJson({
      ...started,
      previousManifestHash: `${HASH}\n`
    })),
    invalid("v6-mutation-final-newline", live.id, canonicalJson({
      ...started,
      unresolvedProvider: { ...started.unresolvedProvider!, mutationId: `${MUTATION_ID}\n` }
    })),
    invalid("v6-started-pointer-mismatch", live.id, canonicalJson({
      ...started,
      lastTransaction: {
        receiptKind: "user",
        mutationId: `m1.1767225600000.${"c".repeat(32)}`,
        phase: "started"
      }
    }), true),
    invalid("v6-unknown-provider-pointer-key", live.id, canonicalJson({
      ...started,
      unresolvedProvider: { ...started.unresolvedProvider!, surprise: true }
    })),
    invalid("v6-unknown-transaction-pointer-key", live.id, canonicalJson({
      ...started,
      lastTransaction: { ...started.lastTransaction!, surprise: true }
    })),
    invalid("v6-invalid-mutation-id", live.id, canonicalJson({
      ...started,
      unresolvedProvider: { mutationId: "m1-invalid", fingerprintHash: HASH }
    })),
    invalid("v6-deleted-started-transaction", deleted.id, canonicalJson({
      ...deleted,
      lastTransaction: { ...deleted.lastTransaction, phase: "started" }
    })),
    valid("v8-live-with-images", live8Images.id, canonicalJson(live8Images)),
    valid("v8-live-without-images", live8Empty.id, canonicalJson(live8Empty)),
    invalid("v7-bare-payload-without-envelope", v7.id, JSON.stringify(v7), true),
    invalid("v7-unknown-node-key", v7WithImages.id, JSON.stringify({
      ...v7WithImages,
      nodes: [{ ...v7WithImages.nodes[0], surprise: true }]
    })),
    invalidNestedV7("v7-image-attachments-over-bound", v7WithImages, (copy) => {
      copy.nodes[0]!.imageAttachments = [0, 1, 2, 3, 4].map((index) =>
        imageAttachment({ objectId: index.toString().repeat(64) }));
    }),
    invalidNestedV7("v7-image-attachments-empty", v7WithImages, (copy) => {
      copy.nodes[0]!.imageAttachments = [];
    }),
    invalidNestedV7("v7-image-attachments-duplicate-object-id", v7WithImages, (copy) => {
      copy.nodes[0]!.imageAttachments = [imageAttachment(), imageAttachment()];
    }, true),
    invalidNestedV7("v7-token-probability-hash-final-newline", v7WithImages, (copy) => {
      copy.nodes[0]!.tokenProbabilityId = `${HASH}\n`;
    })
  ];
}

function v5Manifest(): V5Fixture {
  return {
    format: "1667-story",
    schemaVersion: 5,
    id: "story-one",
    title: "Story",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function storedNode(): Record<string, unknown> {
  return {
    id: "root",
    parentId: null,
    instruction: "",
    model: "test",
    createdAt: NOW,
    preview: "",
    words: 0,
    tokens: 0,
    revisionId: HASH,
    activeChildId: null
  };
}

interface RichV5Fixture extends Omit<V5Fixture, "nodes" | "facts" | "bookmarks" | "chapterBreaks" | "phraseBias"> {
  phraseBias: Array<Record<string, unknown>>;
  origin: Record<string, unknown>;
  autonameId: string;
  nodes: RichNodeFixture[];
  facts: Array<Record<string, unknown>>;
  bookmarks: Array<Record<string, unknown>>;
  chapterBreaks: Array<Record<string, unknown>>;
}

interface RichNodeFixture extends Record<string, unknown> {
  attribution?: {
    source: string;
    ranges: Array<Record<string, unknown>>;
    deletedCharacters?: number;
    surprise?: boolean;
  };
  rewrittenSpans?: Array<Record<string, unknown>>;
  coveredExtent?: Record<string, unknown>;
}

function richV5Manifest(): RichV5Fixture {
  return {
    ...v5Manifest(),
    title: "Complete",
    authorsNote: "A note for the author.",
    authorsNoteDepth: 3,
    authorBrief: "A standing brief for the author.",
    phraseBias: [{ phrase: "delve", weight: -8 }],
    bannedStrings: ["tapestry"],
    factsBudgetTokens: 4_000,
    activeWordCount: 1,
    origin: {
      storyId: "origin-story",
      storyTitle: "Origin",
      partId: "origin-part",
      offset: null,
      createdAt: NOW
    },
    autonameId: "autoname-one",
    nodes: [{
      ...storedNode(),
      preview: "Root",
      words: 1,
      updatedAt: NOW,
      genId: "generation-one",
      rewriteId: "rewrite-one",
      human: true,
      tokenProbabilityId: HASH,
      generationRecordIds: [HASH],
      attribution: { source: "human", ranges: [{ start: 0, end: 1 }], deletedCharacters: 1 },
      rewrittenSpans: [{ start: 2, end: 4 }]
    }, {
      ...storedNode(),
      id: "summary",
      parentId: "root",
      role: "summary",
      chapterBreakId: "break-one",
      coveredExtent: { fromPartId: "root", toPartId: "root" },
      madeAt: NOW,
      editedByUser: true
    }],
    facts: [{
      id: "fact-one",
      tag: "Lore",
      activation: "keyed",
      keys: ["/green, door/i", "green door"],
      secondaryKeys: ["permit"],
      secondaryMode: "not",
      scanDepth: 4,
      recursion: "off",
      priority: "high",
      budgetTokens: 100,
      revisionId: HASH,
      createdAt: NOW,
      updatedAt: NOW,
      sourcePartId: "root"
    }],
    activeRootId: "root",
    bookmarks: [{ nodeId: "summary", name: "Summary", label: "Summary", color: "#000", createdAt: NOW }],
    recentNodeIds: ["summary"],
    chapterBreaks: [{ id: "break-one", parentPartId: "root", title: "Chapter", createdAt: NOW }]
  };
}

function liveManifest(content: V5Fixture): LiveFixture {
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "live",
    id: content.id,
    revision: ONE,
    previousManifestHash: null,
    content,
    summary: {
      id: content.id,
      title: content.title,
      updatedAt: content.updatedAt,
      partCount: 0,
      words: ZERO,
      forked: false,
      lineCount: ZERO
    },
    unresolvedProvider: null,
    lastTransaction: null
  };
}

function deletedManifest(): DeletedFixture {
  return {
    format: "1667-story",
    schemaVersion: 6,
    kind: "deleted",
    id: "story-one",
    revision: TWO,
    previousManifestHash: HASH,
    deletedAt: NOW,
    unresolvedProvider: null,
    lastTransaction: { receiptKind: "user", mutationId: MUTATION_ID, phase: "prepared" }
  };
}

function valid(name: string, expectedId: string, text: string): StoryManifestCorpusCase {
  return { name, expectedId, valid: true, schemaValid: true, text };
}

function invalid(
  name: string,
  expectedId: string,
  text: string,
  schemaValid = false
): StoryManifestCorpusCase {
  return { name, expectedId, valid: false, schemaValid, text };
}

function invalidNestedV5(
  name: string,
  source: RichV5Fixture,
  mutate: (copy: RichV5Fixture) => void
): StoryManifestCorpusCase {
  const copy = structuredClone(source);
  mutate(copy);
  return invalid(name, copy.id, JSON.stringify(copy));
}

/** Mirrors `invalidNestedV5`, for the successor content payload. A duplicate
 *  `objectId` is the one case here that needs `schemaValid = true`: nothing
 *  in the JSON Schema expresses "unique by field," so two structurally valid
 *  Image Attachments only fail at the runtime parser
 *  (`shared/image-attachment.ts`'s `assertStoryImageAttachments`). */
function invalidNestedV7(
  name: string,
  source: V7Fixture,
  mutate: (copy: V7Fixture) => void,
  schemaValid = false
): StoryManifestCorpusCase {
  const copy = structuredClone(source);
  mutate(copy);
  return invalid(name, copy.id, JSON.stringify(copy), schemaValid);
}
