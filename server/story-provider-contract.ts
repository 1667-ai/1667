import type { Story } from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import type {
  MutationResult,
  ProviderMutationMethod
} from "./mutation-ledger-types.js";
import type {
  ProviderStoryEffectByMethod
} from "./story-provider-effect.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import type { PreparedProviderStoryEffect } from "./story-provider-preparation.js";
import type { StoryEnvelopeManifest } from "./story-v6-types.js";

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
 * terminal result already exists. Replay runs inside the aggregate session
 * that recovered the result, so related reads share one snapshot. */
export type ProviderStoryReplay<Value> = (
  session: StoryAggregateSession
) => Value | PromiseLike<Value>;

/** Rebuild a provider result whose request started and whose output was
 * durably materialized, but whose terminal story publication did not finish.
 * The callback must validate the exact retained result before returning it. */
export interface ProviderStoryStartedRecovery<
  Method extends ProviderMutationMethod,
  Value
> {
  readonly value: Value;
  readonly effect: PreparedProviderStoryEffect<ProviderStoryEffectByMethod[Method]>;
}

export type ProviderStoryRun<
  Method extends ProviderMutationMethod,
  Value
> = {
  readonly signal: AbortSignal;
  readonly work: ProviderStoryWork<Method, Value>;
  readonly replayValue: ProviderStoryReplay<Value>;
  readonly recoverStarted?: (
    session: StoryAggregateSession
  ) => ProviderStoryStartedRecovery<Method, Value>
    | PromiseLike<ProviderStoryStartedRecovery<Method, Value>>;
};

export type ProviderStoryAdmission<
  Method extends ProviderMutationMethod,
  Value
> =
  | {
      kind: "replayed";
      commit: Omit<ProviderStoryMutationCommit<Value>, "value">;
      value: Value;
    }
  | {
      kind: "open";
      story: Story;
      /** The exact aggregate manifest admitted with this provider operation. */
      manifest: StoryEnvelopeManifest;
      releaseSnapshot: () => void;
    }
  | {
      kind: "recovering";
      story: Story;
      /** The exact aggregate manifest admitted with this provider operation. */
      manifest: StoryEnvelopeManifest;
      started: import("./mutation-ledger-types.js").StartedMutationRecord;
      value: Value;
      effect: PreparedProviderStoryEffect<ProviderStoryEffectByMethod[Method]>;
    };
