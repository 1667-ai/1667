import type { Story } from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type {
  MutationResult,
  ProviderMutationMethod
} from "./mutation-ledger-types.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";

export interface ProviderStoryMutationCommit<Value> {
  readonly story: Story;
  readonly result: Extract<MutationResult, { kind: "story" }>;
  readonly aggregateVersion: Exclude<
    StoryAggregateVersion,
    { kind: "absent" }
  >;
  readonly value: Value;
}

export interface ProviderStoryWorkContext<
  Method extends ProviderMutationMethod
> {
  readonly stories: ProviderStoryRuntime<Method>;
  readonly providerStarted: () => Promise<void>;
  readonly signal: AbortSignal;
}

export type ProviderStoryWork<
  Method extends ProviderMutationMethod,
  Value
> = (
  context: ProviderStoryWorkContext<Method>
) => Promise<Value>;

/** Reconstruct the value returned by a provider operation whose durable
 * terminal result already exists. Replay runs after the aggregate session
 * that recovered the result has closed, so it may perform its own reads. */
export type ProviderStoryReplay<Value> = () => Value | PromiseLike<Value>;

export type ProviderStoryRun<
  Method extends ProviderMutationMethod,
  Value
> = {
  readonly signal: AbortSignal;
  readonly work: ProviderStoryWork<Method, Value>;
  readonly replayValue: ProviderStoryReplay<Value>;
};

export type ProviderStoryAdmission<Value> =
  | {
      kind: "replayed";
      commit: Omit<ProviderStoryMutationCommit<Value>, "value">;
      replayValue: ProviderStoryReplay<Value>;
    }
  | { kind: "open"; story: Story; releaseSnapshot: () => void };
