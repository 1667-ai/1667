import type {
  Hash256,
  MutationId,
  ProviderPointer,
  Revision20,
  StoryId,
  StorySummaryV6,
  TimeMs,
  UInt64String,
  UserTransactionPointer
} from "./story-v6-types.js";

export type { Hash256, MutationId, Revision20, StoryId, TimeMs, UInt64String } from "./story-v6-types.js";

export type Fm1Key = string;
export type SettingsFormatMigrationV1SourceTag = "file" | "absent-default";
export type LogicalAggregateKey = "settings" | `story:${string}`;
export type MutationLedgerKey = MutationId | Fm1Key;

export const STORY_MUTATION_METHODS = [
  "createStory",
  "renameStory",
  "setAuthorsNote",
  "setAuthorBrief",
  "setFactsBudget",
  "setPhraseBias",
  "setBannedStrings",
  "autonameStory",
  "deleteStory",
  "switchLine",
  "createNode",
  "editNode",
  "deleteNode",
  "pruneUnusedTakes",
  "takeFromCut",
  "pasteStoryLine",
  "putBookmark",
  "deleteBookmark",
  "createFact",
  "patchFact",
  "deleteFact",
  "reorderFact",
  "createChapterBreak",
  "renameChapterBreak",
  "removeChapterBreak",
  "restoreChapterBreak",
  "summarizeChapter",
  "importSillyTavern",
  "importMarkdown",
  "importNovelAI",
  "importScenario",
  "importLorebook",
  "importCard",
  "continueStory",
  "rewriteNode",
  "commitPartialRewrite",
  "createSummaryTake",
  "askAside",
  "clearAside",
  "acknowledgeUnknownOutcomes"

] as const;

export const SETTINGS_MUTATION_METHODS = ["saveSettings", "discardPendingSettings"] as const;
export const INTERNAL_MUTATION_METHODS = ["migrateSettingsFormatV1"] as const;
export const PROVIDER_MUTATION_METHODS = [
  "autonameStory",
  "summarizeChapter",
  "continueStory",
  "rewriteNode",
  "createSummaryTake",
  "askAside"
] as const;
export const ABSENT_STORY_MUTATION_METHODS = ["createStory", "importSillyTavern", "importMarkdown", "importNovelAI", "importScenario"] as const;

export type StoryMutationMethod = typeof STORY_MUTATION_METHODS[number];
export type SettingsMutationMethod = typeof SETTINGS_MUTATION_METHODS[number];
export type InternalMutationMethod = typeof INTERNAL_MUTATION_METHODS[number];
export type DurableMutationMethod = StoryMutationMethod | SettingsMutationMethod | InternalMutationMethod;
export type ProviderMutationMethod = typeof PROVIDER_MUTATION_METHODS[number];

const STORY_METHOD_SET: ReadonlySet<string> = new Set(STORY_MUTATION_METHODS);
const SETTINGS_METHOD_SET: ReadonlySet<string> = new Set(SETTINGS_MUTATION_METHODS);
const INTERNAL_METHOD_SET: ReadonlySet<string> = new Set(INTERNAL_MUTATION_METHODS);
const PROVIDER_METHOD_SET: ReadonlySet<string> = new Set(PROVIDER_MUTATION_METHODS);
const ABSENT_METHOD_SET: ReadonlySet<string> = new Set(ABSENT_STORY_MUTATION_METHODS);

export function isStoryMutationMethod(value: unknown): value is StoryMutationMethod {
  return typeof value === "string" && STORY_METHOD_SET.has(value);
}

export function isSettingsMutationMethod(value: unknown): value is SettingsMutationMethod {
  return typeof value === "string" && SETTINGS_METHOD_SET.has(value);
}

export function isInternalMutationMethod(value: unknown): value is InternalMutationMethod {
  return typeof value === "string" && INTERNAL_METHOD_SET.has(value);
}

export function isDurableMutationMethod(value: unknown): value is DurableMutationMethod {
  return isStoryMutationMethod(value) || isSettingsMutationMethod(value) || isInternalMutationMethod(value);
}

export function isProviderMutationMethod(value: unknown): value is ProviderMutationMethod {
  return typeof value === "string" && PROVIDER_METHOD_SET.has(value);
}

export function isAbsentStoryMutationMethod(value: unknown): value is typeof ABSENT_STORY_MUTATION_METHODS[number] {
  return typeof value === "string" && ABSENT_METHOD_SET.has(value);
}

export function mutationAggregateKind(method: DurableMutationMethod): "story" | "settings" {
  return isStoryMutationMethod(method) ? "story" : "settings";
}

/** Only definitive domain failures may be frozen into Prepared.result. Service,
 * admission, compatibility, retry, recovery, and implementation outcomes stay
 * outside the durable result domain so they cannot poison a later retry. */
export const PREPARED_DOMAIN_ERRORS = [
  "invalid_request",
  "conflict",
  "content_too_large",
  "unprocessable",
  "provider_failure"
] as const;

export type PreparedDomainError = typeof PREPARED_DOMAIN_ERRORS[number];
const PREPARED_DOMAIN_ERROR_SET: ReadonlySet<string> = new Set(PREPARED_DOMAIN_ERRORS);

export function isPreparedDomainError(value: unknown): value is PreparedDomainError {
  return typeof value === "string" && PREPARED_DOMAIN_ERROR_SET.has(value);
}

export type StoryReceiptSummary = Readonly<StorySummaryV6>;

export type AggregateVersion =
  | { readonly kind: "story"; readonly revision: Revision20 }
  | { readonly kind: "settings"; readonly stateGeneration: number };

export type MutationResult =
  | {
      readonly kind: "story";
      readonly storyId: StoryId;
      readonly storyRevision: Revision20;
      readonly summary: StoryReceiptSummary | null;
    }
  | {
      readonly kind: "settings";
      readonly settingsStateGeneration: number;
      readonly activeSettingsRevision: number;
      readonly pendingSettingsRevision: number | null;
    }
  | {
      readonly kind: "error";
      readonly code: PreparedDomainError;
      readonly aggregateVersion: AggregateVersion;
    }
  | {
      readonly kind: "format-migration-v1";
      readonly sourceTag: SettingsFormatMigrationV1SourceTag;
      readonly canonicalV1Hash: Hash256;
    };

export interface StartedMutationRecord {
  readonly schema: 1;
  readonly kind: "started";
  readonly aggregateKey: `story:${string}`;
  readonly mutationId: MutationId;
  readonly fingerprintHash: Hash256;
  readonly method: ProviderMutationMethod;
  readonly oldStateHash: Hash256;
  readonly createdAt: TimeMs;
  /** Ordered Image Object ids the provider request this record starts is
   *  about to send, when it sends any. OPTIONAL on this closed shape, absent
   *  meaning none, so an on-disk record from before Image Input still
   *  parses. Present only for `continueStory`. It is part of this record's
   *  canonical bytes like every other field, so it participates in receipt
   *  identity through the record hash the same way `fingerprintHash` does:
   *  a retry that would carry different images produces a different hash
   *  and fails the fence in server/story-provider-mutation.ts's
   *  `prepareTerminalPhase`. Bounded well under
   *  `MAX_MUTATION_LEDGER_RECORD_BYTES` by the same active-prompt image
   *  count limit the story side enforces (`shared/image-attachment.ts`'s
   *  `MAX_ACTIVE_PROMPT_IMAGES`). Kept live until manifest commit or a
   *  terminal abort. See `server/story-provider-receipt.ts`. */
  readonly imageObjectIds?: readonly Hash256[];
}

export interface PreparedUserMutationRecord {
  readonly schema: 1;
  readonly kind: "prepared";
  readonly purpose: "mutation";
  readonly aggregateKey: LogicalAggregateKey;
  readonly key: MutationId;
  readonly fingerprintHash: Hash256;
  readonly method: Exclude<StoryMutationMethod, "acknowledgeUnknownOutcomes"> | SettingsMutationMethod;
  readonly oldStateHash: Hash256 | "absent";
  readonly newStateHash: Hash256;
  readonly startedRecordHash: Hash256 | null;
  readonly result: MutationResult;
  readonly preparedAt: TimeMs;
}

export interface PreparedInternalMutationRecord {
  readonly schema: 1;
  readonly kind: "prepared";
  readonly purpose: "mutation";
  readonly aggregateKey: "settings";
  readonly key: Fm1Key;
  readonly fingerprintHash: Hash256;
  readonly method: "migrateSettingsFormatV1";
  readonly oldStateHash: Hash256;
  readonly newStateHash: Hash256;
  readonly startedRecordHash: null;
  readonly result: Extract<MutationResult, { kind: "format-migration-v1" }>;
  readonly preparedAt: TimeMs;
}

export type PreparedMutationRecord = PreparedUserMutationRecord | PreparedInternalMutationRecord;

export interface PreparedProviderAcknowledgementRecord {
  readonly schema: 1;
  readonly kind: "prepared";
  readonly purpose: "provider-acknowledgement";
  readonly aggregateKey: `story:${string}`;
  readonly key: MutationId;
  readonly fingerprintHash: Hash256;
  readonly method: "acknowledgeUnknownOutcomes";
  readonly oldStateHash: Hash256;
  readonly newStateHash: Hash256;
  readonly originalProviderMutationId: MutationId;
  readonly originalStartedRecordHash: Hash256;
  readonly result: Extract<MutationResult, { kind: "story" }>;
  readonly preparedAt: TimeMs;
}

export type PreparedRecord = PreparedMutationRecord | PreparedProviderAcknowledgementRecord;

export interface CompletedMutationRecord {
  readonly schema: 1;
  readonly kind: "completed";
  readonly aggregateKey: LogicalAggregateKey;
  readonly key: MutationLedgerKey;
  readonly preparedRecordHash: Hash256;
  readonly completedAt: TimeMs;
}

export type CompletedInternalMutationRecord = CompletedMutationRecord & {
  readonly aggregateKey: "settings";
  readonly key: Fm1Key;
};

export type FormatMigrationReceiptRecord =
  | PreparedInternalMutationRecord
  | CompletedInternalMutationRecord;

export interface AcknowledgedMutationRecord {
  readonly schema: 1;
  readonly kind: "acknowledged";
  readonly aggregateKey: `story:${string}`;
  readonly mutationId: MutationId;
  readonly startedRecordHash: Hash256;
  readonly acknowledgementMutationId: MutationId;
  readonly acknowledgementPreparedHash: Hash256;
  readonly acknowledgedAt: TimeMs;
}

export type MutationLedgerRecord =
  | StartedMutationRecord
  | PreparedRecord
  | CompletedMutationRecord
  | AcknowledgedMutationRecord;

export type StoryTransactionPointer = Readonly<UserTransactionPointer>;

export type SettingsTransactionPointer =
  | { readonly receiptKind: "user"; readonly mutationId: MutationId; readonly phase: "prepared" }
  | { readonly receiptKind: "format-migration-v1"; readonly key: Fm1Key; readonly phase: "prepared" };

export type AggregateTransactionPointer = StoryTransactionPointer | SettingsTransactionPointer;

/**
 * V6 uses its exact wire projection. A strict V5 predecessor is projected as
 * the logical revision-1 root with a null predecessor; its stateHash remains
 * the domain-separated hash of the exact V5 bytes.
 */
export type RecoveryStoryStateProjection = Readonly<Extract<MutationResult, { kind: "story" }>> & {
  readonly previousManifestHash: Hash256 | null;
};

export type RecoverySettingsStateProjection = Readonly<Extract<MutationResult, { kind: "settings" }>>;
export type RecoveryStateProjection = RecoveryStoryStateProjection | RecoverySettingsStateProjection;

export interface RecoveryAggregateEvidence {
  readonly stateHash: Hash256 | "absent";
  readonly state: RecoveryStateProjection | null;
  readonly lastTransaction: AggregateTransactionPointer | null;
  readonly unresolvedProvider: Readonly<ProviderPointer> | null;
}
