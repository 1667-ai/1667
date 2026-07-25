import type { Story } from "../shared/types.js";
import type { MutationResult } from "./mutation-ledger-types.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";

export interface ProviderStoryMutationCommit<Value> {
  readonly story: Story;
  readonly result: Extract<MutationResult, { kind: "story" }>;
  readonly value: Value;
}

export type ProviderStoryWork<Value> = (
  stories: ProviderStoryRuntime,
  providerStarted: () => Promise<void>
) => Promise<Value>;

export type ProviderStoryAdmission<Value> =
  | { kind: "replayed"; commit: ProviderStoryMutationCommit<Value> }
  | { kind: "open"; story: Story; releaseSnapshot: () => void };
