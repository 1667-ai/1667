import { HASH_PATTERN } from "../server/story-format-facts.js";
import {
  DECIMAL_20_PATTERN_SOURCE,
  FM1_KEY_PATTERN_SOURCE,
  MUTATION_ID_PATTERN_SOURCE,
  TIME_MS_PATTERN_SOURCE,
  UINT64_MAX_DECIMAL
} from "../server/mutation-ledger-scalars.js";
import {
  INTERNAL_MUTATION_METHODS,
  PREPARED_DOMAIN_ERRORS,
  PROVIDER_MUTATION_METHODS,
  SETTINGS_MUTATION_METHODS,
  STORY_MUTATION_METHODS
} from "../server/mutation-ledger-types.js";
import { MAX_STORY_TITLE_CHARS, STORY_ID_PATTERN_SOURCE } from "../server/story-v5-strict.js";
import { exactStringPatternSource } from "../server/story-wire-patterns.js";

type Schema = Record<string, unknown>;

export function mutationLedgerSchema(): Schema {
  const userMethods = [...STORY_MUTATION_METHODS, ...SETTINGS_MUTATION_METHODS]
    .filter((method) => method !== "acknowledgeUnknownOutcomes");
  const definitions: Record<string, Schema> = {
    StoryId: stringPattern(STORY_ID_PATTERN_SOURCE),
    StoryAggregateKey: stringPattern(`story:${STORY_ID_PATTERN_SOURCE}`),
    LogicalAggregateKey: { oneOf: [{ const: "settings" }, ref("StoryAggregateKey")] },
    MutationId: stringPattern(MUTATION_ID_PATTERN_SOURCE),
    Fm1Key: stringPattern(FM1_KEY_PATTERN_SOURCE),
    MutationLedgerKey: { oneOf: [ref("MutationId"), ref("Fm1Key")] },
    Hash256: { type: "string", pattern: HASH_PATTERN.source },
    TimeMs: stringPattern(TIME_MS_PATTERN_SOURCE),
    UInt53: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    UInt64String: { type: "string", pattern: fixedDecimalAtMost(UINT64_MAX_DECIMAL) },
    Revision20: { allOf: [ref("UInt64String"), { not: { const: "00000000000000000000" } }] },
    StorySummary: closed({
      id: ref("StoryId"),
      title: { type: "string", maxLength: MAX_STORY_TITLE_CHARS },
      updatedAt: ref("TimeMs"),
      partCount: { type: "integer", minimum: 0, maximum: 0xffff_ffff },
      words: ref("UInt64String"),
      forked: { type: "boolean" },
      lineCount: ref("UInt64String")
    }),
    StoryResult: closed({
      kind: { const: "story" },
      storyId: ref("StoryId"),
      storyRevision: ref("Revision20"),
      summary: nullable(ref("StorySummary"))
    }),
    SettingsResult: closed({
      kind: { const: "settings" },
      settingsStateGeneration: ref("UInt53"),
      activeSettingsRevision: ref("UInt53"),
      pendingSettingsRevision: nullable(ref("UInt53"))
    }),
    StoryAggregateVersion: closed({ kind: { const: "story" }, revision: ref("Revision20") }),
    SettingsAggregateVersion: closed({ kind: { const: "settings" }, stateGeneration: ref("UInt53") }),
    ErrorResult: closed({
      kind: { const: "error" },
      code: { enum: [...PREPARED_DOMAIN_ERRORS] },
      aggregateVersion: { oneOf: [ref("StoryAggregateVersion"), ref("SettingsAggregateVersion")] }
    }),
    FormatMigrationResult: closed({
      kind: { const: "format-migration-v1" },
      sourceTag: { enum: ["file", "absent-default"] },
      canonicalV1Hash: ref("Hash256")
    }),
    UserMutationResult: {
      oneOf: [ref("StoryResult"), ref("SettingsResult"), ref("ErrorResult")]
    },
    Started: closedWithOptional(
      {
        schema: { const: 1 },
        kind: { const: "started" },
        aggregateKey: ref("StoryAggregateKey"),
        mutationId: ref("MutationId"),
        fingerprintHash: ref("Hash256"),
        method: { enum: [...PROVIDER_MUTATION_METHODS] },
        oldStateHash: ref("Hash256"),
        createdAt: ref("TimeMs")
      },
      {
        // Ordered Image Object ids the provider request is about to send.
        // Optional so an on-disk record from before Image Input still
        // parses; when present it is never empty, mirroring every other
        // "absence means none" list in this codebase.
        imageObjectIds: { type: "array", minItems: 1, maxItems: 4, items: ref("Hash256") }
      }
    ),
    PreparedUserMutation: closed({
      schema: { const: 1 },
      kind: { const: "prepared" },
      purpose: { const: "mutation" },
      aggregateKey: ref("LogicalAggregateKey"),
      key: ref("MutationId"),
      fingerprintHash: ref("Hash256"),
      method: { enum: userMethods },
      oldStateHash: { oneOf: [ref("Hash256"), { const: "absent" }] },
      newStateHash: ref("Hash256"),
      startedRecordHash: nullable(ref("Hash256")),
      result: ref("UserMutationResult"),
      preparedAt: ref("TimeMs")
    }),
    PreparedInternalMutation: closed({
      schema: { const: 1 },
      kind: { const: "prepared" },
      purpose: { const: "mutation" },
      aggregateKey: { const: "settings" },
      key: ref("Fm1Key"),
      fingerprintHash: ref("Hash256"),
      method: { enum: [...INTERNAL_MUTATION_METHODS] },
      oldStateHash: ref("Hash256"),
      newStateHash: ref("Hash256"),
      startedRecordHash: { type: "null" },
      result: ref("FormatMigrationResult"),
      preparedAt: ref("TimeMs")
    }),
    PreparedProviderAcknowledgement: closed({
      schema: { const: 1 },
      kind: { const: "prepared" },
      purpose: { const: "provider-acknowledgement" },
      aggregateKey: ref("StoryAggregateKey"),
      key: ref("MutationId"),
      fingerprintHash: ref("Hash256"),
      method: { const: "acknowledgeUnknownOutcomes" },
      oldStateHash: ref("Hash256"),
      newStateHash: ref("Hash256"),
      originalProviderMutationId: ref("MutationId"),
      originalStartedRecordHash: ref("Hash256"),
      result: ref("StoryResult"),
      preparedAt: ref("TimeMs")
    }),
    Completed: closed({
      schema: { const: 1 },
      kind: { const: "completed" },
      aggregateKey: ref("LogicalAggregateKey"),
      key: ref("MutationLedgerKey"),
      preparedRecordHash: ref("Hash256"),
      completedAt: ref("TimeMs")
    }),
    Acknowledged: closed({
      schema: { const: 1 },
      kind: { const: "acknowledged" },
      aggregateKey: ref("StoryAggregateKey"),
      mutationId: ref("MutationId"),
      startedRecordHash: ref("Hash256"),
      acknowledgementMutationId: ref("MutationId"),
      acknowledgementPreparedHash: ref("Hash256"),
      acknowledgedAt: ref("TimeMs")
    })
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://1667.invalid/schema/mutation-ledger-p2.json",
    title: "1667 common mutation ledger records",
    oneOf: [
      ref("Started"),
      ref("PreparedUserMutation"),
      ref("PreparedInternalMutation"),
      ref("PreparedProviderAcknowledgement"),
      ref("Completed"),
      ref("Acknowledged")
    ],
    $defs: definitions
  };
}

function closed(properties: Record<string, Schema>): Schema {
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}

/** Like `closed`, but `optional`'s keys are allowed and validated when
 * present without being required. This is the JSON Schema shape for an
 * OPTIONAL closed-shape key: `server/story-wire-validation.ts`'s
 * `closedShape` with a non-empty second argument is the same idea on the
 * parser side. */
function closedWithOptional(required: Record<string, Schema>, optional: Record<string, Schema>): Schema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...required, ...optional },
    required: Object.keys(required)
  };
}

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function nullable(schema: Schema): Schema {
  return { oneOf: [{ type: "null" }, schema] };
}

function stringPattern(source: string): Schema {
  return { type: "string", pattern: exactStringPatternSource(source) };
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
