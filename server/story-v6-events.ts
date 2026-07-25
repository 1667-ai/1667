import type { StoryManifestV5 } from "./story-format.js";
import type {
  Hash256,
  MutationId,
  ProviderPointer,
  StoryManifestV6,
  StorySummaryV6,
  TimeMs
} from "./story-v6-types.js";

export type StoryV6ReducerState =
  | { kind: "absent" }
  | { kind: "present"; manifest: StoryManifestV6; manifestHash: Hash256 };

export interface PreparedStoryContent {
  content: StoryManifestV5;
  summary: StorySummaryV6;
}

export type ProviderTerminalOutcome =
  | ({ kind: "success" } & PreparedStoryContent)
  | { kind: "error" };

interface ExistingStoryEvent {
  /** Hash of the exact authoritative canonical bytes parsed into the input manifest. */
  expectedManifestHash: Hash256;
}

interface CreationPreparedEvent extends PreparedStoryContent {
  mutationId: MutationId;
}

export type StoryV6Event =
  | ({ kind: "create-prepared" } & CreationPreparedEvent)
  | ({ kind: "import-prepared" } & CreationPreparedEvent)
  | ({ kind: "local-prepared"; mutationId: MutationId } & PreparedStoryContent & ExistingStoryEvent)
  | ({ kind: "provider-started"; provider: ProviderPointer } & ExistingStoryEvent)
  | ({
      kind: "provider-terminal-prepared";
      provider: ProviderPointer;
      outcome: ProviderTerminalOutcome;
    } & ExistingStoryEvent)
  | ({
      kind: "acknowledge-prepared";
      provider: ProviderPointer;
      acknowledgementMutationId: MutationId;
    } & ExistingStoryEvent)
  | ({ kind: "delete-prepared"; mutationId: MutationId; deletedAt: TimeMs } & ExistingStoryEvent)
  | ({ kind: "receipt-retry" } & ExistingStoryEvent)
  | ({ kind: "receipt-gc" } & ExistingStoryEvent)
  | ({ kind: "physical-reap-after-expiry" } & ExistingStoryEvent);
