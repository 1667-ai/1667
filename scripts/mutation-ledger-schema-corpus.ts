import { canonicalJson } from "../server/canonical-json.js";
import { MAX_MUTATION_LEDGER_RECORD_BYTES } from "../server/mutation-ledger-scalars.js";
import { prepareSettingsFormatMigrationV1Receipt } from "../server/settings-format-migration-receipt.js";
import { storyIdForMutation } from "../server/story-identity.js";

export interface MutationLedgerCorpusCase {
  readonly name: string;
  readonly valid: boolean;
  readonly schemaValid: boolean;
  readonly text: string;
}

const NOW = "2026-01-01T00:00:00.000Z";
const MUTATION = `m1.1767225600000.${"d".repeat(32)}`;
const ACK_MUTATION = `m1.1767225600001.${"e".repeat(32)}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const REVISION = "00000000000000000002";
const REVISION_ONE = "00000000000000000001";
const ZERO = "00000000000000000000";

export function mutationLedgerCorpus(): MutationLedgerCorpusCase[] {
  const started = startedRecord();
  const startedWithImages = { ...started, imageObjectIds: [HASH_B, HASH_C] };
  const storyPrepared = preparedStory();
  const providerPrepared = {
    ...storyPrepared,
    method: "continueStory",
    startedRecordHash: HASH_C
  };
  const receiptOnly = {
    ...storyPrepared,
    method: "renameStory",
    newStateHash: HASH_A,
    startedRecordHash: null,
    result: {
      kind: "error",
      code: "conflict",
      aggregateVersion: { kind: "story", revision: REVISION }
    }
  };
  const createPrepared = preparedCreate();
  const settingsPrepared = preparedSettings();
  const migrationPrepared = preparedMigration();
  const acknowledgementPrepared = preparedAcknowledgement();
  const completed = completedRecord(storyPrepared);
  const acknowledged = acknowledgedRecord();
  const large = preparedStory("\u0000".repeat(4_096));
  const largeText = canonicalJson(large);
  const oversized = `${largeText}${" ".repeat(MAX_MUTATION_LEDGER_RECORD_BYTES - Buffer.byteLength(largeText) + 1)}`;

  return [
    valid("started-provider-story", started),
    valid("started-provider-story-with-images", startedWithImages),
    valid("prepared-story-local", storyPrepared),
    valid("prepared-story-with-fact-state-deletion", {
      ...storyPrepared,
      method: "deleteNode",
      result: { ...storyPrepared.result, factStatesRemoved: 2 }
    }),
    valid("prepared-story-provider-terminal", providerPrepared),
    valid("prepared-receipt-only-error", receiptOnly),
    valid("prepared-create-deterministic", createPrepared),
    valid("prepared-settings", settingsPrepared),
    valid("prepared-format-migration", migrationPrepared),
    valid("prepared-provider-acknowledgement", acknowledgementPrepared),
    valid("completed-user", completed),
    valid("completed-internal", completedRecord(migrationPrepared)),
    valid("acknowledged-provider", acknowledged),
    valid("prepared-4096-escaped-control-title", large),
    invalidText("noncanonical-property-order", JSON.stringify(started), true),
    invalidText("trailing-byte", `${canonicalJson(started)}\n`, true),
    invalidText("leading-bom", `\ufeff${canonicalJson(started)}`, false),
    invalidText("duplicate-root-key", canonicalJson(started).replace("{", '{"schema":1,'), true),
    invalid("unknown-root-key", { ...started, surprise: true }, false),
    invalid("started-settings-aggregate", { ...started, aggregateKey: "settings" }, false),
    invalid("started-local-method", { ...started, method: "renameStory" }, false),
    invalid("started-empty-image-object-ids", { ...started, imageObjectIds: [] }, false),
    invalid(
      "started-too-many-image-object-ids",
      { ...started, imageObjectIds: [HASH_A, HASH_B, HASH_C, HASH_A, HASH_B] },
      false
    ),
    invalid("started-malformed-image-object-id", { ...started, imageObjectIds: ["not-a-hash"] }, false),
    invalid("prepared-story-id-mismatch", {
      ...storyPrepared,
      result: { ...storyPrepared.result, storyId: "other-story" }
    }, true),
    invalid("prepared-summary-id-mismatch", {
      ...storyPrepared,
      result: {
        ...storyPrepared.result,
        summary: { ...storyPrepared.result.summary, id: "other-story" }
      }
    }, true),
    invalid("prepared-method-aggregate-mismatch", {
      ...storyPrepared,
      aggregateKey: "settings"
    }, true),
    invalid("prepared-service-only-error", {
      ...receiptOnly,
      result: { ...receiptOnly.result, code: "revision_conflict" }
    }, false),
    invalid("prepared-provider-success-without-started", {
      ...providerPrepared,
      startedRecordHash: null
    }, true),
    invalid("prepared-local-success-with-started", {
      ...storyPrepared,
      startedRecordHash: HASH_C
    }, true),
    invalid("prepared-receipt-only-hash-change", {
      ...receiptOnly,
      newStateHash: HASH_B
    }, true),
    invalid("prepared-provider-failure-on-local-method", {
      ...receiptOnly,
      result: { ...receiptOnly.result, code: "provider_failure" }
    }, true),
    invalid("prepared-absent-non-create", { ...storyPrepared, oldStateHash: "absent" }, true),
    invalid("prepared-create-legacy-id", createWithStoryId(createPrepared, "story-one"), true),
    invalid(
      "prepared-create-wrong-derived-id",
      createWithStoryId(createPrepared, `st1_${"a".repeat(52)}`),
      true
    ),
    invalid("prepared-create-revision-two", {
      ...createPrepared,
      result: { ...createPrepared.result, storyRevision: REVISION }
    }, true),
    invalid("prepared-delete-with-live-summary", { ...storyPrepared, method: "deleteStory" }, true),
    invalid("prepared-discard-with-pending", {
      ...settingsPrepared,
      method: "discardPendingSettings",
      result: { ...settingsPrepared.result, pendingSettingsRevision: 3 }
    }, true),
    invalid("prepared-migration-key-result-mismatch", {
      ...migrationPrepared,
      result: { ...migrationPrepared.result, canonicalV1Hash: HASH_B }
    }, true),
    invalid("acknowledgement-same-mutation", {
      ...acknowledgementPrepared,
      originalProviderMutationId: ACK_MUTATION
    }, true),
    invalid("acknowledgement-error-result", {
      ...acknowledgementPrepared,
      result: {
        kind: "error",
        code: "conflict",
        aggregateVersion: { kind: "story", revision: REVISION }
      }
    }, false),
    invalid("acknowledgement-unchanged-state", {
      ...acknowledgementPrepared,
      newStateHash: HASH_A
    }, true),
    invalid("acknowledged-same-mutation", {
      ...acknowledged,
      acknowledgementMutationId: MUTATION
    }, true),
    invalid("error-version-kind-mismatch", {
      ...receiptOnly,
      result: {
        ...receiptOnly.result,
        aggregateVersion: { kind: "settings", stateGeneration: 2 }
      }
    }, true),
    invalid("invalid-calendar-time", { ...started, createdAt: "2026-02-30T00:00:00.000Z" }, true),
    invalid("nfd-title", preparedStory("Cafe\u0301"), true),
    invalidText(
      "unpaired-surrogate-title",
      canonicalJson(preparedStory()).replace('"title":"Story"', '"title":"\\ud800"'),
      true
    ),
    invalid("prepared-4097-title-scalars", preparedStory("\u0000".repeat(4_097)), false),
    invalidText("record-over-32-kib", oversized, true)
  ];
}

function startedRecord(): Record<string, unknown> {
  return {
    schema: 1,
    kind: "started",
    aggregateKey: "story:story-one",
    mutationId: MUTATION,
    fingerprintHash: HASH_A,
    method: "continueStory",
    oldStateHash: HASH_A,
    createdAt: NOW
  };
}

function preparedStory(title = "Story"): Record<string, any> {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "story:story-one",
    key: MUTATION,
    fingerprintHash: HASH_A,
    method: "renameStory",
    oldStateHash: HASH_A,
    newStateHash: HASH_B,
    startedRecordHash: null,
    result: {
      kind: "story",
      storyId: "story-one",
      storyRevision: REVISION,
      summary: {
        id: "story-one",
        title,
        updatedAt: NOW,
        partCount: 1,
        words: ZERO,
        forked: false,
        lineCount: ZERO
      }
    },
    preparedAt: NOW
  };
}

function preparedCreate(): Record<string, any> {
  const storyId = storyIdForMutation(MUTATION);
  return {
    ...preparedStory(),
    aggregateKey: `story:${storyId}`,
    method: "createStory",
    oldStateHash: "absent",
    result: {
      ...preparedStory().result,
      storyId,
      storyRevision: REVISION_ONE,
      summary: { ...preparedStory().result.summary, id: storyId }
    }
  };
}

function createWithStoryId(prepared: Record<string, any>, storyId: string): Record<string, any> {
  return {
    ...prepared,
    aggregateKey: `story:${storyId}`,
    result: {
      ...prepared.result,
      storyId,
      summary: { ...prepared.result.summary, id: storyId }
    }
  };
}

function preparedSettings(): Record<string, any> {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key: MUTATION,
    fingerprintHash: HASH_A,
    method: "saveSettings",
    oldStateHash: HASH_A,
    newStateHash: HASH_B,
    startedRecordHash: null,
    result: {
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 1,
      pendingSettingsRevision: 2
    },
    preparedAt: NOW
  };
}

function preparedMigration(): Record<string, any> {
  return prepareSettingsFormatMigrationV1Receipt({
    sourceTag: "file",
    canonicalV1Hash: HASH_A,
    newStateHash: HASH_B,
    preparedAt: NOW
  });
}

function preparedAcknowledgement(): Record<string, any> {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "provider-acknowledgement",
    aggregateKey: "story:story-one",
    key: ACK_MUTATION,
    fingerprintHash: HASH_A,
    method: "acknowledgeUnknownOutcomes",
    oldStateHash: HASH_A,
    newStateHash: HASH_B,
    originalProviderMutationId: MUTATION,
    originalStartedRecordHash: HASH_C,
    result: {
      kind: "story",
      storyId: "story-one",
      storyRevision: REVISION,
      summary: null
    },
    preparedAt: NOW
  };
}

function completedRecord(prepared: Record<string, any>): Record<string, unknown> {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: prepared.aggregateKey,
    key: prepared.key,
    preparedRecordHash: HASH_C,
    completedAt: NOW
  };
}

function acknowledgedRecord(): Record<string, unknown> {
  return {
    schema: 1,
    kind: "acknowledged",
    aggregateKey: "story:story-one",
    mutationId: MUTATION,
    startedRecordHash: HASH_C,
    acknowledgementMutationId: ACK_MUTATION,
    acknowledgementPreparedHash: HASH_B,
    acknowledgedAt: NOW
  };
}

function valid(name: string, value: unknown): MutationLedgerCorpusCase {
  return { name, valid: true, schemaValid: true, text: canonicalJson(value) };
}

function invalid(name: string, value: unknown, schemaValid: boolean): MutationLedgerCorpusCase {
  return invalidText(name, canonicalJson(value), schemaValid);
}

function invalidText(name: string, text: string, schemaValid: boolean): MutationLedgerCorpusCase {
  return { name, valid: false, schemaValid, text };
}
