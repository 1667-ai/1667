import {
  MAX_STORY_COLLECTION_ITEMS,
  MAX_STORY_COLOR_CHARS,
  MAX_STORY_IDENTIFIER_CHARS,
  MAX_STORY_INSTRUCTION_CHARS,
  MAX_STORY_MODEL_CHARS,
  MAX_STORY_TIMESTAMP_CHARS,
  MAX_STORY_TITLE_CHARS,
  STORY_ID_PATTERN_SOURCE
} from "../server/story-v5-strict.js";
import {
  MAX_FACTS,
  MAX_FACT_TAG_CHARS,
  MAX_HUMAN_EDIT_RANGES,
  MAX_RECENT_LINES
} from "../shared/types.js";
import { MAX_AUTHORS_NOTE_CHARS } from "../shared/authors-note.js";
import { HASH_PATTERN } from "../server/story-format-facts.js";
import { exactStringPatternSource } from "../server/story-wire-patterns.js";
import {
  REVISION_ONE,
  TIME_MS_PATTERN_SOURCE,
  UINT64_MAX_DECIMAL,
  V6_MUTATION_ID_PATTERN_SOURCE,
  ZERO_20
} from "../server/story-v6-scalars.js";

type Schema = Record<string, unknown>;

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export function storyManifestSchema(): Schema {
  const definitions: Record<string, Schema> = {
    StoryId: {
      type: "string",
      pattern: exactStringPatternSource(STORY_ID_PATTERN_SOURCE)
    },
    Identifier: { type: "string", minLength: 1, maxLength: MAX_STORY_IDENTIFIER_CHARS },
    Hash256: { type: "string", pattern: HASH_PATTERN.source },
    V5Timestamp: { type: "string", maxLength: MAX_STORY_TIMESTAMP_CHARS },
    TimeMs: { type: "string", pattern: exactStringPatternSource(TIME_MS_PATTERN_SOURCE) },
    UInt64String: { type: "string", pattern: fixedDecimalAtMost(UINT64_MAX_DECIMAL) },
    Revision20: {
      allOf: [ref("UInt64String"), { not: { const: ZERO_20 } }]
    },
    MutationId: { type: "string", pattern: exactStringPatternSource(V6_MUTATION_ID_PATTERN_SOURCE) },
    Origin: closed({
      storyId: ref("StoryId"),
      storyTitle: boundedString(MAX_STORY_TITLE_CHARS),
      partId: ref("Identifier"),
      offset: { oneOf: [{ type: "null" }, unsignedInteger()] },
      createdAt: ref("V5Timestamp")
    }),
    TextRange: closed({ start: unsignedInteger(), end: unsignedInteger() }),
    Attribution: closed({
      source: { const: "human" },
      ranges: { type: "array", maxItems: MAX_HUMAN_EDIT_RANGES, items: ref("TextRange") },
      deletedCharacters: { ...unsignedInteger(), minimum: 1 }
    }, ["source", "ranges"]),
    CoveredExtent: closed({ fromPartId: ref("Identifier"), toPartId: ref("Identifier") }),
    StoredNodeV5: nodeSchema(),
    StoredFactV5: closed({
      id: ref("Identifier"),
      tag: { oneOf: [{ type: "null" }, boundedString(MAX_FACT_TAG_CHARS)] },
      revisionId: ref("Hash256"),
      createdAt: ref("V5Timestamp"),
      updatedAt: ref("V5Timestamp"),
      sourcePartId: ref("Identifier")
    }, ["id", "tag", "revisionId", "createdAt", "updatedAt"]),
    StoredTagV5: closed({
      nodeId: ref("Identifier"),
      name: { type: "string", minLength: 1, maxLength: 80 },
      label: { enum: ["", "Canon", "Alt", "Draft", "Discarded", "Summary"] },
      color: boundedString(MAX_STORY_COLOR_CHARS),
      createdAt: ref("V5Timestamp")
    }),
    ChapterBreakV5: closed({
      id: ref("Identifier"),
      parentPartId: ref("Identifier"),
      title: boundedString(MAX_STORY_TITLE_CHARS),
      createdAt: ref("V5Timestamp")
    }),
    StrictV5Payload: strictV5Schema(),
    ProviderPointer: closed({ mutationId: ref("MutationId"), fingerprintHash: ref("Hash256") }),
    StartedUserTransactionPointer: closed({
      receiptKind: { const: "user" }, mutationId: ref("MutationId"), phase: { const: "started" }
    }),
    PreparedUserTransactionPointer: closed({
      receiptKind: { const: "user" }, mutationId: ref("MutationId"), phase: { const: "prepared" }
    }),
    UserTransactionPointer: {
      oneOf: [ref("StartedUserTransactionPointer"), ref("PreparedUserTransactionPointer")]
    },
    StorySummaryV6: closed({
      id: ref("StoryId"),
      title: boundedString(MAX_STORY_TITLE_CHARS),
      updatedAt: ref("TimeMs"),
      partCount: { type: "integer", minimum: 0, maximum: 0xffff_ffff },
      words: ref("UInt64String"),
      forked: { type: "boolean" },
      lineCount: ref("UInt64String")
    }),
    LiveV6: liveV6Schema(),
    DeletedV6: deletedV6Schema()
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://1667.invalid/schema/story-manifest-p1.json",
    title: "1667 strict V5 and V6 story manifests",
    oneOf: [ref("StrictV5Payload"), ref("LiveV6"), ref("DeletedV6")],
    $defs: definitions
  };
}

function nodeSchema(): Schema {
  const properties: Record<string, Schema> = {
    id: ref("Identifier"),
    parentId: nullable(ref("Identifier")),
    instruction: boundedString(MAX_STORY_INSTRUCTION_CHARS),
    model: boundedString(MAX_STORY_MODEL_CHARS),
    createdAt: ref("V5Timestamp"),
    preview: boundedString(100),
    words: unsignedInteger(),
    tokens: unsignedInteger(),
    updatedAt: ref("V5Timestamp"),
    genId: ref("Identifier"),
    rewriteId: ref("Identifier"),
    role: { const: "summary" },
    chapterBreakId: ref("Identifier"),
    coveredExtent: ref("CoveredExtent"),
    madeAt: ref("V5Timestamp"),
    editedByUser: { const: true },
    human: { const: true },
    syntheticEmpty: { const: true },
    revisionId: ref("Hash256"),
    attribution: nullable(ref("Attribution")),
    activeChildId: nullable(ref("Identifier"))
  };
  return {
    ...closed(properties, ["id", "parentId", "instruction", "model", "createdAt", "revisionId", "activeChildId"]),
    allOf: [
      paired("preview", ["preview", "words"]),
      paired("words", ["preview", "words"]),
      paired("chapterBreakId", ["chapterBreakId", "coveredExtent", "madeAt"]),
      paired("coveredExtent", ["chapterBreakId", "coveredExtent", "madeAt"]),
      paired("madeAt", ["chapterBreakId", "coveredExtent", "madeAt"]),
      paired("editedByUser", ["chapterBreakId", "coveredExtent", "madeAt"])
    ]
  };
}

function strictV5Schema(): Schema {
  return closed({
    format: { const: "1667-story" },
    schemaVersion: { const: 5 },
    id: ref("StoryId"),
    title: boundedString(MAX_STORY_TITLE_CHARS),
    createdAt: ref("V5Timestamp"),
    updatedAt: ref("V5Timestamp"),
    origin: ref("Origin"),
    autonameId: ref("Identifier"),
    // Every other chapter is named by the break that opens it. The first
    // chapter has no such break, so its name lives here. Absent on every
    // manifest written before chapter one could be named, and absent again
    // whenever the name is cleared.
    authorsNote: boundedString(MAX_AUTHORS_NOTE_CHARS),
    firstChapterTitle: boundedString(MAX_STORY_TITLE_CHARS),
    activeWordCount: unsignedInteger(),
    nodes: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref("StoredNodeV5") },
    facts: { type: "array", maxItems: MAX_FACTS, items: ref("StoredFactV5") },
    activeRootId: nullable(ref("Identifier")),
    bookmarks: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref("StoredTagV5") },
    recentNodeIds: { type: "array", maxItems: MAX_RECENT_LINES, items: ref("Identifier") },
    chapterBreaks: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref("ChapterBreakV5") }
  }, [
    "format", "schemaVersion", "id", "title", "createdAt", "updatedAt", "activeWordCount", "nodes",
    "facts", "activeRootId", "bookmarks", "recentNodeIds", "chapterBreaks"
  ]);
}

function liveV6Schema(): Schema {
  return {
    ...closed({
      format: { const: "1667-story" },
      schemaVersion: { const: 6 },
      kind: { const: "live" },
      id: ref("StoryId"),
      revision: ref("Revision20"),
      previousManifestHash: nullable(ref("Hash256")),
      content: ref("StrictV5Payload"),
      summary: ref("StorySummaryV6"),
      unresolvedProvider: nullable(ref("ProviderPointer")),
      lastTransaction: nullable(ref("UserTransactionPointer"))
    }),
    allOf: [{
      oneOf: [
        {
          properties: { revision: { const: REVISION_ONE }, previousManifestHash: { type: "null" } },
          required: ["revision", "previousManifestHash"]
        },
        {
          properties: {
            revision: { allOf: [ref("Revision20"), { not: { const: REVISION_ONE } }] },
            previousManifestHash: ref("Hash256")
          },
          required: ["revision", "previousManifestHash"]
        }
      ]
    }]
  };
}

function deletedV6Schema(): Schema {
  return closed({
    format: { const: "1667-story" },
    schemaVersion: { const: 6 },
    kind: { const: "deleted" },
    id: ref("StoryId"),
    revision: { allOf: [ref("Revision20"), { not: { const: REVISION_ONE } }] },
    previousManifestHash: ref("Hash256"),
    deletedAt: ref("TimeMs"),
    unresolvedProvider: nullable(ref("ProviderPointer")),
    lastTransaction: ref("PreparedUserTransactionPointer")
  });
}

function closed(properties: Record<string, Schema>, required = Object.keys(properties)): Schema {
  return { type: "object", additionalProperties: false, properties, required };
}

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function nullable(schema: Schema): Schema {
  return { oneOf: [{ type: "null" }, schema] };
}

function boundedString(maxLength: number): Schema {
  return { type: "string", maxLength };
}

function unsignedInteger(): Schema {
  return { type: "integer", minimum: 0, maximum: SAFE_INTEGER };
}

function paired(trigger: string, required: string[]): Schema {
  return {
    if: { properties: { [trigger]: {} }, required: [trigger] },
    then: { properties: Object.fromEntries(required.map((key) => [key, {}])), required }
  };
}

function fixedDecimalAtMost(maximum: string): string {
  const alternatives: string[] = [];
  for (let index = 0; index < maximum.length; index += 1) {
    const digit = Number(maximum[index]);
    if (digit === 0) continue;
    const prefix = maximum.slice(0, index);
    const lower = digit === 1 ? "0" : `[0-${digit - 1}]`;
    const remaining = maximum.length - index - 1;
    alternatives.push(`${prefix}${lower}${remaining === 0 ? "" : `[0-9]{${remaining}}`}`);
  }
  alternatives.push(maximum);
  return exactStringPatternSource(alternatives.join("|"));
}
