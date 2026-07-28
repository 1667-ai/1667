import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import { storyIdForMutation } from "./story-identity.js";
import { isStoryId } from "./story-v5-strict.js";
import {
  DECIMAL_20_PATTERN,
  REVISION_ONE,
  TIME_MS_PATTERN,
  UINT64_MAX,
  V6_MUTATION_ID_PATTERN
} from "./story-v6-scalars.js";
import type {
  ProviderTerminalOutcome,
  StoryV6Event,
  StoryV6ReducerState
} from "./story-v6-events.js";
import type {
  Hash256,
  LiveStoryManifestV6,
  MutationId,
  PreparedUserTransactionPointer,
  ProviderPointer,
  Revision20,
  StoryManifestV6,
  StorySummaryV6,
  TimeMs,
  UserTransactionPointer
} from "./story-v6-types.js";

/**
 * Apply one already-authorized event without I/O or serialization.
 * Event content/summary pairs must already have passed the strict wire/domain validators.
 */
export function reduceStoryV6(
  state: StoryV6ReducerState,
  event: StoryV6Event
): StoryManifestV6 | null {
  if (event.kind === "create-prepared" || event.kind === "import-prepared") {
    if (state.kind !== "absent") return illegal(state, event);
    requireMutationId(event.mutationId);
    const storyId = storyIdForMutation(event.mutationId);
    requireReplacementIdentity(storyId, event.summary, event.content.id);
    return {
      format: "1667-story",
      schemaVersion: 6,
      kind: "live",
      id: storyId,
      revision: REVISION_ONE,
      previousManifestHash: null,
      content: event.content,
      summary: event.summary,
      unresolvedProvider: null,
      lastTransaction: preparedPointer(event.mutationId)
    };
  }

  if (state.kind !== "present") return illegal(state, event);
  const { manifest } = state;
  const previousManifestHash = requireExpectedManifestHash(state.manifestHash, event.expectedManifestHash);

  switch (event.kind) {
    case "local-prepared":
    case "local-committed": {
      requireLive(manifest, event);
      requireReplacementIdentity(manifest.id, event.summary, event.content.id);
      // "local-committed" may only be reduced by the manifest-only commit
      // path: its null pointer promises recovery that no ledger records were
      // written for this replacement — nothing here can verify that promise.
      let pointer: PreparedUserTransactionPointer | null = null;
      if (event.kind === "local-prepared") {
        requireMutationId(event.mutationId);
        pointer = preparedPointer(event.mutationId);
      }
      return nextLive(manifest, previousManifestHash, pointer, {
        content: event.content,
        summary: event.summary,
        unresolvedProvider: manifest.unresolvedProvider
      });
    }
    case "provider-started": {
      requireLive(manifest, event);
      requireProviderPointer(event.provider);
      if (manifest.unresolvedProvider !== null) return illegal(state, event);
      return nextLive(manifest, previousManifestHash, startedPointer(event.provider.mutationId), {
        content: manifest.content,
        summary: manifest.summary,
        unresolvedProvider: event.provider
      });
    }
    case "provider-terminal-prepared": {
      requireMatchingProvider(manifest.unresolvedProvider, event.provider);
      if (manifest.kind === "deleted") {
        if (event.outcome.kind !== "error") return illegal(state, event);
        return {
          ...manifest,
          revision: incrementRevision(manifest.revision),
          previousManifestHash,
          unresolvedProvider: null,
          lastTransaction: preparedPointer(event.provider.mutationId)
        };
      }
      const replacement = terminalReplacement(manifest, event.outcome);
      return nextLive(manifest, previousManifestHash, preparedPointer(event.provider.mutationId), {
        ...replacement,
        unresolvedProvider: null
      });
    }
    case "acknowledge-prepared": {
      requireMatchingProvider(manifest.unresolvedProvider, event.provider);
      requireMutationId(event.acknowledgementMutationId);
      if (event.acknowledgementMutationId === event.provider.mutationId) {
        throw new StoryFormatError("Acknowledgement mutation must differ from the provider mutation");
      }
      const lastTransaction = preparedPointer(event.acknowledgementMutationId);
      if (manifest.kind === "live") {
        return nextLive(manifest, previousManifestHash, lastTransaction, {
          content: manifest.content,
          summary: manifest.summary,
          unresolvedProvider: null
        });
      }
      return {
        ...manifest,
        revision: incrementRevision(manifest.revision),
        previousManifestHash,
        unresolvedProvider: null,
        lastTransaction
      };
    }
    case "delete-prepared": {
      requireLive(manifest, event);
      requireMutationId(event.mutationId);
      requireTimeMs(event.deletedAt);
      return {
        format: "1667-story",
        schemaVersion: 6,
        kind: "deleted",
        id: manifest.id,
        revision: incrementRevision(manifest.revision),
        previousManifestHash,
        deletedAt: event.deletedAt,
        unresolvedProvider: manifest.unresolvedProvider,
        lastTransaction: preparedPointer(event.mutationId)
      };
    }
    case "receipt-retry":
    case "receipt-gc":
      return manifest;
    case "physical-reap-after-expiry":
      if (manifest.kind !== "deleted" || manifest.unresolvedProvider !== null) return illegal(state, event);
      return null;
    default:
      return assertNever(event);
  }
}

interface NextLiveValues {
  content: LiveStoryManifestV6["content"];
  summary: StorySummaryV6;
  unresolvedProvider: ProviderPointer | null;
}

function nextLive(
  manifest: LiveStoryManifestV6,
  previousManifestHash: Hash256,
  lastTransaction: UserTransactionPointer | null,
  values: NextLiveValues
): LiveStoryManifestV6 {
  return {
    ...manifest,
    revision: incrementRevision(manifest.revision),
    previousManifestHash,
    content: values.content,
    summary: values.summary,
    unresolvedProvider: values.unresolvedProvider,
    lastTransaction
  };
}

function terminalReplacement(
  manifest: LiveStoryManifestV6,
  outcome: ProviderTerminalOutcome
): Pick<NextLiveValues, "content" | "summary"> {
  if (outcome.kind === "error") return { content: manifest.content, summary: manifest.summary };
  if (outcome.kind !== "success") throw new StoryFormatError("Unknown provider terminal outcome");
  requireReplacementIdentity(manifest.id, outcome.summary, outcome.content.id);
  return { content: outcome.content, summary: outcome.summary };
}

function requireLive(manifest: StoryManifestV6, event: StoryV6Event): asserts manifest is LiveStoryManifestV6 {
  if (manifest.kind !== "live") {
    throw new StoryFormatError(`Illegal story V6 transition: ${manifest.kind} + ${event.kind}`);
  }
}

function requireMatchingProvider(actual: ProviderPointer | null, expected: ProviderPointer): void {
  requireProviderPointer(expected);
  if (
    actual === null
    || actual.mutationId !== expected.mutationId
    || actual.fingerprintHash !== expected.fingerprintHash
  ) throw new StoryFormatError("Provider event does not match unresolvedProvider");
}

function requireProviderPointer(pointer: ProviderPointer): void {
  requireMutationId(pointer.mutationId);
  requireHash(pointer.fingerprintHash, "provider fingerprint hash");
}

function requireReplacementIdentity(expectedId: string, summary: StorySummaryV6, contentId = expectedId): void {
  if (!isStoryId(expectedId) || contentId !== expectedId || summary.id !== expectedId) {
    throw new StoryFormatError("Replacement content and summary must match the story id");
  }
}

function requireExpectedManifestHash(actual: Hash256, expected: Hash256): Hash256 {
  requireHash(actual, "input manifest hash");
  requireHash(expected, "expected manifest hash");
  if (actual !== expected) throw new StoryFormatError("Expected manifest hash does not match the input manifest");
  return actual;
}

function requireHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) throw new StoryFormatError(`Invalid ${label}`);
}

function requireMutationId(value: MutationId): void {
  if (!V6_MUTATION_ID_PATTERN.test(value)) throw new StoryFormatError("Invalid mutation id");
}

function requireTimeMs(value: TimeMs): void {
  if (!TIME_MS_PATTERN.test(value)) throw new StoryFormatError("Invalid deletion time");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new StoryFormatError("Invalid deletion time");
  }
}

function incrementRevision(revision: Revision20): Revision20 {
  if (!DECIMAL_20_PATTERN.test(revision)) throw new StoryFormatError("Invalid input story revision");
  const value = BigInt(revision);
  if (value < 1n || value >= UINT64_MAX) throw new StoryFormatError("Story revision overflow");
  return (value + 1n).toString().padStart(20, "0");
}

function preparedPointer(mutationId: MutationId): PreparedUserTransactionPointer {
  return { receiptKind: "user", mutationId, phase: "prepared" };
}

function startedPointer(mutationId: MutationId): UserTransactionPointer {
  return { receiptKind: "user", mutationId, phase: "started" };
}

function illegal(state: StoryV6ReducerState, event: StoryV6Event): never {
  const stateKind = state.kind === "absent" ? "absent" : state.manifest.kind;
  throw new StoryFormatError(`Illegal story V6 transition: ${stateKind} + ${event.kind}`);
}

function assertNever(value: never): never {
  throw new StoryFormatError(`Unknown story V6 event: ${String((value as { kind?: unknown }).kind)}`);
}
