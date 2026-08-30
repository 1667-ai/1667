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
  MAX_FACT_STATES,
  MAX_FACT_TAG_CHARS,
  MAX_GENERATION_RECORD_IDS,
  MAX_HUMAN_EDIT_RANGES,
  MAX_RECENT_LINES,
  MAX_REWRITTEN_SPANS
} from "../shared/types.js";
import { MAX_AUTHORS_NOTE_CHARS, MAX_AUTHORS_NOTE_DEPTH } from "../shared/authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS } from "../shared/author-brief.js";
import { MAX_FACT_NAME_CHARS } from "../shared/fact-name.js";
import { FACT_PRIORITIES, MAX_FACT_KEY_SCALARS, MAX_FACT_KEYS } from "../shared/fact-metadata.js";
import { MAX_FACT_BUDGET_TOKENS, MAX_STORY_FACTS_BUDGET_TOKENS } from "../shared/fact-budget.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";
import {
  MAX_ACTIVE_PROMPT_IMAGES,
  MAX_IMAGE_OBJECT_BYTES,
  MAX_NORMALIZED_IMAGE_DIMENSION,
  STORED_IMAGE_MEDIA_TYPES
} from "../shared/image-attachment.js";
import { HASH_PATTERN } from "../server/story-format-facts.js";
import { MAX_SESSION_REFS_PER_BUCKET } from "../server/story-v11-strict.js";
import {
  STORY_ASIDE_SCHEMA_VERSION,
  STORY_ASIDE_SESSION_SCHEMA_VERSION,
  STORY_SUCCESSOR_SCHEMA_VERSION
} from "../server/story-format.js";
import {
  STORY_SCHEMA_VERSION_V8,
  STORY_SCHEMA_VERSION_V10,
  STORY_SCHEMA_VERSION_V12
} from "../server/story-v6-codec.js";
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
    FactActivation: { enum: ["always", "keyed"] },
    FactPriority: { enum: [...FACT_PRIORITIES] },
    FactSecondaryMode: { enum: ["and", "not"] },
    FactRecursion: { enum: ["on", "off"] },
    FactKey: {
      oneOf: [
        { allOf: [
          { type: "string", minLength: 1, maxLength: MAX_FACT_KEY_SCALARS, pattern: exactStringPatternSource("[^,\\r\\n\\u2028\\u2029]+") },
          { not: { type: "string", pattern: exactStringPatternSource("/(?:\\\\.|[^/\\r\\n\\u2028\\u2029])*/[dgimsuvy]*") } }
        ] },
        { type: "string", minLength: 2, maxLength: MAX_FACT_KEY_SCALARS, pattern: exactStringPatternSource("/(?:\\\\.|[^/\\r\\n\\u2028\\u2029])*/[is]*") }
      ]
    },
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
    StoredNodeV7: nodeSchema({ imageAttachments: ref("ImageAttachments") }),
    StoredImageMediaType: { enum: [...STORED_IMAGE_MEDIA_TYPES] },
    ImageAttachment: closed({
      objectId: ref("Hash256"),
      mediaType: ref("StoredImageMediaType"),
      width: boundedInteger(1, MAX_NORMALIZED_IMAGE_DIMENSION),
      height: boundedInteger(1, MAX_NORMALIZED_IMAGE_DIMENSION),
      byteLength: boundedInteger(1, MAX_IMAGE_OBJECT_BYTES)
    }),
    // Absence means no images; an empty array is invalid. So the array
    // itself, not just its items, carries a minimum length.
    ImageAttachments: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ACTIVE_PROMPT_IMAGES,
      items: ref("ImageAttachment")
    },
    StoredFactV5: closed({
      id: ref("Identifier"),
      tag: { oneOf: [{ type: "null" }, boundedString(MAX_FACT_TAG_CHARS)] },
      revisionId: ref("Hash256"),
      createdAt: ref("V5Timestamp"),
      updatedAt: ref("V5Timestamp"),
      sourcePartId: ref("Identifier"),
      activation: ref("FactActivation"),
      keys: {
        type: "array",
        maxItems: MAX_FACT_KEYS,
        items: ref("FactKey")
      },
      secondaryKeys: { type: "array", maxItems: MAX_FACT_KEYS, items: ref("FactKey") },
      secondaryMode: ref("FactSecondaryMode"),
      scanDepth: boundedInteger(1, 20),
      recursion: ref("FactRecursion"),
      priority: ref("FactPriority"),
      budgetTokens: boundedInteger(1, MAX_FACT_BUDGET_TOKENS)
    }, ["id", "tag", "revisionId", "createdAt", "updatedAt"]),
    FactTextStateV13: closed({
      id: ref("Identifier"),
      anchorPartId: ref("Identifier"),
      revisionId: ref("Hash256"),
      createdAt: ref("V5Timestamp"),
      updatedAt: ref("V5Timestamp")
    }, ["id", "revisionId", "createdAt", "updatedAt"]),
    FactEndStateV13: closed({
      id: ref("Identifier"),
      anchorPartId: ref("Identifier"),
      ends: { const: true },
      createdAt: ref("V5Timestamp"),
      updatedAt: ref("V5Timestamp")
    }, ["id", "ends", "createdAt", "updatedAt"]),
    FactStateV13: {
      oneOf: [ref("FactTextStateV13"), ref("FactEndStateV13")]
    },
    StoredFactV13: closed({
      id: ref("Identifier"),
      name: { type: "string", minLength: 1, maxLength: MAX_FACT_NAME_CHARS },
      tag: { oneOf: [{ type: "null" }, boundedString(MAX_FACT_TAG_CHARS)] },
      createdAt: ref("V5Timestamp"),
      updatedAt: ref("V5Timestamp"),
      sourcePartId: ref("Identifier"),
      activation: ref("FactActivation"),
      keys: { type: "array", maxItems: MAX_FACT_KEYS, items: ref("FactKey") },
      secondaryKeys: { type: "array", maxItems: MAX_FACT_KEYS, items: ref("FactKey") },
      secondaryMode: ref("FactSecondaryMode"),
      scanDepth: boundedInteger(1, 20),
      recursion: ref("FactRecursion"),
      priority: ref("FactPriority"),
      budgetTokens: boundedInteger(1, MAX_FACT_BUDGET_TOKENS),
      states: { type: "array", minItems: 1, maxItems: MAX_FACT_STATES, items: ref("FactStateV13") }
    }, ["id", "tag", "createdAt", "updatedAt", "states"]),
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
    PhraseBiasEntryV5: closed({
      phrase: { type: "string", minLength: 1, maxLength: SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars },
      weight: boundedInteger(SAMPLING_PHRASE_BIAS_POLICY.minimum, SAMPLING_PHRASE_BIAS_POLICY.maximum)
    }),
    StrictV5Payload: strictContentSchema(5, "StoredNodeV5"),
    StrictV7Payload: strictContentSchema(STORY_SUCCESSOR_SCHEMA_VERSION, "StoredNodeV7"),
    StrictV9Payload: asideContentSchema(STORY_ASIDE_SCHEMA_VERSION, "StoredNodeV7"),
    AsideAnchor: closed({ partId: ref("Identifier"), takeId: ref("Identifier") }),
    AsideSessionRef: closed({
      id: { type: "string", minLength: 1, maxLength: 128 },
      documentId: ref("Hash256"),
      anchor: nullable(ref("AsideAnchor")),
      sourceAsideDocumentId: ref("Hash256"),
      originAnchor: nullable(ref("AsideAnchor")),
      turnCount: boundedInteger(0, 100)
    }, ["id", "documentId", "anchor", "turnCount"]),
    AsideAnchoredSessionRef: {
      allOf: [
        ref("AsideSessionRef"),
        { type: "object", properties: { anchor: ref("AsideAnchor") }, required: ["anchor"] }
      ]
    },
    AsideUnanchoredSessionRef: {
      allOf: [
        ref("AsideSessionRef"),
        { type: "object", properties: { anchor: { const: null } }, required: ["anchor"] }
      ]
    },
    StrictV11Payload: asideSessionContentSchema(STORY_ASIDE_SESSION_SCHEMA_VERSION, "StoredNodeV7"),
    StrictV13Payload: asideSessionContentSchema(13, "StoredNodeV7", "StoredFactV13"),
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
    LiveV6: liveV6Schema(6, "StrictV5Payload"),
    DeletedV6: deletedV6Schema(6),
    LiveV8: liveV6Schema(STORY_SCHEMA_VERSION_V8, "StrictV7Payload"),
    DeletedV8: deletedV6Schema(STORY_SCHEMA_VERSION_V8),
    LiveV10: liveV6Schema(STORY_SCHEMA_VERSION_V10, "StrictV9Payload"),
    DeletedV10: deletedV6Schema(STORY_SCHEMA_VERSION_V10),
    LiveV12: liveV6Schema(STORY_SCHEMA_VERSION_V12, "StrictV11Payload"),
    DeletedV12: deletedV6Schema(STORY_SCHEMA_VERSION_V12),
    LiveV14: liveV6Schema(14, "StrictV13Payload"),
    DeletedV14: deletedV6Schema(14)
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://1667.invalid/schema/story-manifest-p2.json",
    title: "1667 strict V5, V6, V7, V8, V9, V10, V11, V12, V13, and V14 story manifests",
    oneOf: [
      ref("StrictV5Payload"),
      ref("LiveV6"),
      ref("DeletedV6"),
      ref("StrictV7Payload"),
      ref("LiveV8"),
      ref("DeletedV8"),
      ref("StrictV9Payload"),
      ref("LiveV10"),
      ref("DeletedV10"),
      ref("StrictV11Payload"),
      ref("LiveV12"),
      ref("DeletedV12"),
      ref("StrictV13Payload"),
      ref("LiveV14"),
      ref("DeletedV14")
    ],
    $defs: definitions
  };
}

/** `extraProperties` is how the successor node shape (`StoredNodeV7`) adds
 * `imageAttachments` without repeating every field the two shapes share. It
 * mirrors `NODE7` in `server/story-v7-strict.ts`, which derives from
 * `NODE.required`/`NODE.allowed` the same way instead of re-listing them. */
function nodeSchema(extraProperties: Record<string, Schema> = {}): Schema {
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
    // The stored alternative tokens of this take. Absent when the generation
    // did not ask for them.
    tokenProbabilityId: ref("Hash256"),
    // Ordered ids of every Generation Record event that created or changed
    // this node. Absent for a node with no model-request history.
    generationRecordIds: { type: "array", minItems: 1, maxItems: MAX_GENERATION_RECORD_IDS, items: ref("Hash256") },
    // This take's stored reasoning ("thought"). Absent when the generation
    // produced none, when retention was off, or when a rewrite replaced the
    // take's text without producing a fresh thought of its own.
    reasoningId: ref("Hash256"),
    attribution: nullable(ref("Attribution")),
    rewrittenSpans: { type: "array", maxItems: MAX_REWRITTEN_SPANS, items: ref("TextRange") },
    activeChildId: nullable(ref("Identifier")),
    ...extraProperties
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

/** `StrictV5Payload` and `StrictV7Payload` share every manifest-root field;
 * the successor only widens which node shape `nodes[]` may hold. Mirrors
 * `assertManifestCommonFields` in `server/story-v5-strict.ts`, which the
 * runtime parser shares the same way. */
function strictContentSchema(schemaVersion: number, nodeRef: string, factRef = "StoredFactV5"): Schema {
  return closed({
    format: { const: "1667-story" },
    schemaVersion: { const: schemaVersion },
    id: ref("StoryId"),
    title: boundedString(MAX_STORY_TITLE_CHARS),
    createdAt: ref("V5Timestamp"),
    updatedAt: ref("V5Timestamp"),
    origin: ref("Origin"),
    autonameId: ref("Identifier"),
    authorsNote: boundedString(MAX_AUTHORS_NOTE_CHARS),
    // How many story parts from the end the note lands before. Absent means
    // the default placement (immediately before the last part).
    authorsNoteDepth: boundedInteger(1, MAX_AUTHORS_NOTE_DEPTH),
    // Story-scoped override of the machine-wide author brief. Absent falls
    // back to the machine-wide value; absent again whenever it is cleared.
    authorBrief: boundedString(MAX_AUTHOR_BRIEF_CHARS),
    // Adds to the routed profile's own phraseBias/bannedStrings rather than
    // replacing it (issue #341). Absent means the story contributes nothing
    // beyond the profile's own value; absent again once cleared back to empty.
    phraseBias: {
      type: "array",
      maxItems: SAMPLING_PHRASE_BIAS_POLICY.maxEntries,
      items: ref("PhraseBiasEntryV5")
    },
    bannedStrings: {
      type: "array",
      maxItems: SAMPLING_BANNED_STRINGS_POLICY.maxEntries,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: SAMPLING_BANNED_STRINGS_POLICY.maxScalars }
    },
    // Every other chapter is named by the break that opens it. The first
    // chapter has no such break, so its name lives here. Absent on every
    // manifest written before chapter one could be named, and absent again
    // whenever the name is cleared.
    firstChapterTitle: boundedString(MAX_STORY_TITLE_CHARS),
    factsBudgetTokens: boundedInteger(1, MAX_STORY_FACTS_BUDGET_TOKENS),
    activeWordCount: unsignedInteger(),
    nodes: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref(nodeRef) },
    facts: { type: "array", maxItems: MAX_FACTS, items: ref(factRef) },
    activeRootId: nullable(ref("Identifier")),
    bookmarks: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref("StoredTagV5") },
    recentNodeIds: { type: "array", maxItems: MAX_RECENT_LINES, items: ref("Identifier") },
    chapterBreaks: { type: "array", maxItems: MAX_STORY_COLLECTION_ITEMS, items: ref("ChapterBreakV5") }
  }, [
    "format", "schemaVersion", "id", "title", "createdAt", "updatedAt", "activeWordCount", "nodes",
    "facts", "activeRootId", "bookmarks", "recentNodeIds", "chapterBreaks"
  ]);
}

/** V9 content: every V7 field plus required nullable asideDocumentId. */
function asideContentSchema(schemaVersion: number, nodeRef: string, factRef = "StoredFactV5"): Schema {
  const base = strictContentSchema(schemaVersion, nodeRef, factRef) as Schema & {
    properties: Record<string, Schema>;
    required: string[];
  };
  return {
    ...base,
    properties: {
      ...base.properties,
      asideDocumentId: { oneOf: [{ type: "null" }, ref("Hash256")] }
    },
    required: [...base.required, "asideDocumentId"]
  };
}

/** V11 content: V9 plus text-free session references. Session text remains
 * in separate content-addressed Aside objects. */
function asideSessionContentSchema(schemaVersion: number, nodeRef: string, factRef = "StoredFactV5"): Schema {
  const base = asideContentSchema(schemaVersion, nodeRef, factRef) as Schema & {
    properties: Record<string, Schema>;
    required: string[];
  };
  const anchoredRefs = {
    type: "array",
    maxItems: MAX_SESSION_REFS_PER_BUCKET,
    items: ref("AsideAnchoredSessionRef")
  };
  const unanchoredRefs = {
    type: "array",
    maxItems: MAX_SESSION_REFS_PER_BUCKET,
    items: ref("AsideUnanchoredSessionRef")
  };
  return {
    ...base,
    properties: {
      ...base.properties,
      asideSessionRefs: anchoredRefs,
      asideUnanchoredSessionRefs: unanchoredRefs
    },
    required: [...base.required, "asideSessionRefs", "asideUnanchoredSessionRefs"]
  };
}

/** Shared by `LiveV6` and `LiveV8`: one envelope shape, two possible content
 * versions. Mirrors `LIVE` in `server/story-v6-codec.ts`, reused verbatim by
 * the runtime V8 parser for exactly this reason. */
function liveV6Schema(schemaVersion: number, contentRef: string): Schema {
  return {
    ...closed({
      format: { const: "1667-story" },
      schemaVersion: { const: schemaVersion },
      kind: { const: "live" },
      id: ref("StoryId"),
      revision: ref("Revision20"),
      previousManifestHash: nullable(ref("Hash256")),
      content: ref(contentRef),
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

function deletedV6Schema(schemaVersion: number): Schema {
  return closed({
    format: { const: "1667-story" },
    schemaVersion: { const: schemaVersion },
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

function boundedInteger(minimum: number, maximum: number): Schema {
  return { type: "integer", minimum, maximum };
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
