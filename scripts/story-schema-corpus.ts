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
  authorBrief?: string;
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
    invalidNestedV5("v5-unknown-extent-key", richV5, (copy) => {
      copy.nodes[1]!.coveredExtent!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-fact-key", richV5, (copy) => {
      copy.facts[0]!.surprise = true;
    }),
    invalidNestedV5("v5-comma-in-fact-key", richV5, (copy) => {
      copy.facts[0]!.keys = ["red, blue"];
    }),
    invalidNestedV5("v5-unknown-tag-key", richV5, (copy) => {
      copy.bookmarks[0]!.surprise = true;
    }),
    invalidNestedV5("v5-unknown-chapter-key", richV5, (copy) => {
      copy.chapterBreaks[0]!.surprise = true;
    }),
    invalid("v5-title-over-bound", v5.id, JSON.stringify({ ...v5, title: "x".repeat(4_097) })),
    invalid("v5-authors-note-over-bound", v5.id, JSON.stringify({ ...v5, authorsNote: "x".repeat(4_001) })),
    invalid("v5-author-brief-over-bound", v5.id, JSON.stringify({ ...v5, authorBrief: "x".repeat(65_537) })),
    invalid("v5-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, title: "\ud800" }), true),
    invalid("v5-authors-note-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, authorsNote: "\ud800" }), true),
    invalid("v5-author-brief-unpaired-surrogate", v5.id, JSON.stringify({ ...v5, authorBrief: "\ud800" }), true),
    invalid("v5-story-id-final-newline", `${v5.id}\n`, JSON.stringify({ ...v5, id: `${v5.id}\n` })),
    invalid("v5-hash-final-newline", nodeV5.id, JSON.stringify({
      ...nodeV5,
      nodes: [{ ...nodeV5.nodes[0], revisionId: `${HASH}\n` }]
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
    }))
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

interface RichV5Fixture extends Omit<V5Fixture, "nodes" | "facts" | "bookmarks" | "chapterBreaks"> {
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
  coveredExtent?: Record<string, unknown>;
}

function richV5Manifest(): RichV5Fixture {
  return {
    ...v5Manifest(),
    title: "Complete",
    authorsNote: "A note for the author.",
    authorBrief: "A standing brief for the author.",
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
      attribution: { source: "human", ranges: [{ start: 0, end: 1 }], deletedCharacters: 1 }
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
      keys: ["door", "green door"],
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
