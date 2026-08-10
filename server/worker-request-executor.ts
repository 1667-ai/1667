import {
  STREAM_METHODS,
  isLocalDurabilityMutation,
  isMutatingWorkerMethod,
  isServiceOwnedSettingsMutation,
  isWorkerMutationMethod,
  workerOperationKey,
  type LocalDurabilityMutationMethod,
  type MainToWorkerMessage,
  type WorkerMethod,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import {
  isRetryablePartialSettlementFailure,
  ProviderError,
  ServiceError,
  timeoutProvenanceOf
} from "./errors.js";
import type { ReasoningStreamDelta } from "./providers.js";
import {
  parseStoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import {
  isProviderRecoveryContext
} from "../shared/provider-recovery.js";
import { mutationFingerprint } from "./mutation-receipts.js";
import { toPublicServiceError } from "./service-error-policy.js";
import { StoryService } from "./story-service.js";
import { storyIdForMutation } from "./story-identity.js";
import { requireRecord, requireString } from "./validation.js";
import { WorkerDeltaBatcher } from "./worker-delta-batcher.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  preflightWorkerMutation,
  storyIdForWorkerMutation
} from "./worker-mutations.js";
import { WorkerRequestCancellation } from "./worker-request-cancellation.js";
import { WorkerRequestFailureResponder } from "./worker-request-failure-responder.js";
import { requireImageInputEntryPointsOpen, withImageStagePermit } from "./image-stage-permit.js";
import { isSourceImageMediaType, type SourceImageMediaType } from "../shared/image-attachment.js";

type WorkerRequest = Extract<MainToWorkerMessage, { type: "request" }>;
type WorkerTerminalMessage = Extract<
  WorkerToMainMessage,
  { type: "result" | "complete" }
>;

const PARTIAL_SETTLEMENT_RETRY_MS = 25;

export async function executeWorkerRequest(
  service: StoryService,
  message: WorkerRequest,
  cancellation: WorkerRequestCancellation,
  deltas: WorkerDeltaBatcher | null,
  failures: WorkerRequestFailureResponder,
  publishTerminal: (
    message: WorkerTerminalMessage,
    state: "completed" | "canceled"
  ) => void
): Promise<void> {
  const stream = STREAM_METHODS.has(message.method);
  try {
    const onDelta = (text: string) => deltas?.push(text);
    // Same batcher, same shared sequence/ack/credit machinery as `onDelta`
    // above — see `WorkerDeltaBatcher.pushReasoning`. Reasoning text never
    // travels through `onDelta`'s own text accumulator, so it can never be
    // coalesced into a batch a caller reads as story prose.
    const onReasoning = (delta: ReasoningStreamDelta) => deltas?.pushReasoning(delta.text, delta.tokenCount);
    let value: unknown;
    if (isServiceOwnedSettingsMutation(message.method)) {
      value = await executeSettingsMutation(service, message, cancellation.signal);
    } else if (message.mutationId === undefined) {
      value = await invokeReadOnly(
        service,
        message.method,
        message.input,
        cancellation.signal
      );
    } else {
      value = await executeWorkerMutationWithRetry(
        service,
        message,
        onDelta,
        onReasoning,
        cancellation
      );
    }
    cancellation.throwIfDeadlineExpired();
    if (
      stream
      && (cancellation.signal.aborted || value === null || value === false)
    ) {
      if (cancellation.signal.aborted) {
        deltas?.sealUnsent();
        await deltas?.publishSealed();
      }
      deltas?.dispose();
      publishTerminal(
        {
          type: "complete",
          id: message.id,
          value: null
        },
        cancellation.signal.aborted ? "canceled" : "completed"
      );
      return;
    }
    await deltas?.flush();
    // A user cancellation can arrive while success settlement waits for
    // transport credit. The worker seals that accepted tail at receipt, so
    // settle it before the canceled terminal instead of publishing success.
    // Deadline handling stays below: its error terminal preserves recovery
    // semantics.
    if (stream && cancellation.userCancellationRequested) {
      deltas?.sealUnsent();
      await deltas?.publishSealed();
      deltas?.dispose();
      publishTerminal(
        {
          type: "complete",
          id: message.id,
          value: null
        },
        "canceled"
      );
      return;
    }
    cancellation.throwIfDeadlineExpired();
    publishTerminal(
      stream
        ? { type: "complete", id: message.id, value }
        : { type: "result", id: message.id, value },
      "completed"
    );
  } catch (error) {
    if (stream && cancellation.settledUserCancellation(error)) {
      deltas?.sealUnsent();
      await deltas?.publishSealed();
      deltas?.dispose();
      publishTerminal(
        {
          type: "complete",
          id: message.id,
          value: null
        },
        "canceled"
      );
      return;
    }
    const failure = cancellation.failure(error);
    const outcome = isWorkerMutationMethod(message.method)
      ? mutationOutcome(failure.error)
      : undefined;
    // A deadline seals accepted stream text at cancellation receipt. Publish
    // that tail as normal bounded deltas before the error terminal, so a
    // single oversized provider delta cannot make the terminal malformed.
    if (stream && cancellation.signal.aborted) deltas?.sealUnsent();
    if (outcome === "uncertain" && !cancellation.signal.aborted) {
      deltas?.dispose();
    }
    else {
      await deltas?.flush();
      // A clean provider timeout can reach this catch before the worker
      // deadline. If cancellation seals a credit-blocked tail while flush
      // waits, this publishes it before the error terminal.
      if (stream && (cancellation.signal.aborted
        || timeoutProvenanceOf(failure.error) !== null)) {
        await deltas?.publishSealed();
      }
    }
    await failures.tracked(
      failure.error,
      outcome
    );
  } finally {
    deltas?.dispose();
  }
}

async function executeSettingsMutation(
  service: StoryService,
  message: WorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  const input = requireRecord(message.input, `${message.method} input`);
  const command = requireRecord(input.command, "command");
  return message.method === "saveSettings"
    ? await service.saveSettings(command, signal)
    : await service.discardPendingSettings(command);
}

async function executeMutation(
  service: StoryService,
  message: WorkerRequest,
  onDelta: (text: string) => void,
  onReasoning: (delta: ReasoningStreamDelta) => void,
  signal: AbortSignal
): Promise<unknown> {
  const method = message.method;
  if (!isMutatingWorkerMethod(method)) {
    throw new ServiceError(400, `${method} is not a mutation`);
  }
  let parsed:
    ReturnType<typeof parseWorkerMutation<typeof method>>
    | undefined;
  // Local durability tier, selected by the explicit wire marker and never by
  // method inference: the transport sets the marker only on a fresh call
  // without a durable replay source, so an outbox replay retained by any
  // build — which arrives without the marker — always takes the full
  // receipt/ledger path below. `parseWorkerRequest` already rejected the
  // marker for anything but a listed local mutation with an aggregate version.
  if (message.durability === "manifest-only" && isLocalDurabilityMutation(method)) {
    return await executeLocalTierMutation(
      service,
      message,
      method,
      onDelta,
      onReasoning,
      signal
    );
  }
  // Exact terminal replays invoke neither callback. New/pending work parses
  // once after receipt identity wins and preflights before persistence.
  const input = () => parsed ??= parseWorkerMutation(
    method,
    message.input,
    message.protocolVersion
  );
  return await service.runMutation(
    message.mutationId!,
    method,
    message.input,
    (plan) => {
      const parsedInput = input();
      const storyId = message.expectedAggregateVersion !== null
        && typeof message.expectedAggregateVersion === "object"
        && "kind" in message.expectedAggregateVersion
        && message.expectedAggregateVersion.kind === "absent"
        ? storyIdForMutation(message.mutationId!)
        : storyIdForWorkerMutation(parsedInput, plan);
      const storyMutationRequest =
        message.expectedAggregateVersion === undefined || storyId === null
          ? undefined
          : {
              transportOperationId: workerOperationKey(message.id),
              mutationId: message.mutationId!,
              fingerprint: mutationFingerprint(
                method,
                message.input,
                message.protocolVersion
              ),
              scope: `story:${storyId}` as const,
              expectedAggregateVersion: message.expectedAggregateVersion
            };
      return executeWorkerMutation(service, parsedInput, plan, {
        onDelta,
        onReasoning,
        signal,
        ...(storyMutationRequest === undefined
          ? {}
          : { storyMutationRequest })
      });
    },
    message.protocolVersion,
    (plan) => message.expectedAggregateVersion === undefined
      ? preflightWorkerMutation(service, input(), plan)
      : undefined
  );
}

async function executeLocalTierMutation<M extends LocalDurabilityMutationMethod>(
  service: StoryService,
  message: WorkerRequest,
  method: M,
  onDelta: (text: string) => void,
  onReasoning: (delta: ReasoningStreamDelta) => void,
  signal: AbortSignal
): Promise<unknown> {
  return await service.runLocalMutation(
    message.mutationId!,
    method,
    (plan) => {
      const parsedInput = parseWorkerMutation(
        method,
        message.input,
        message.protocolVersion
      );
      const storyId = storyIdForWorkerMutation(parsedInput, plan);
      if (storyId === null) {
        throw new ServiceError(
          500,
          `Local mutation ${method} has no aggregate target`
        );
      }
      return executeWorkerMutation(service, parsedInput, plan, {
        onDelta,
        onReasoning,
        signal,
        storyMutationRequest: {
          transportOperationId: workerOperationKey(message.id),
          mutationId: message.mutationId!,
          fingerprint: mutationFingerprint(
            method,
            message.input,
            message.protocolVersion
          ),
          durability: "manifest-only",
          scope: `story:${storyId}` as const,
          expectedAggregateVersion: message.expectedAggregateVersion
        }
      });
    }
  );
}

async function invokeReadOnly(
  service: StoryService,
  method: WorkerMethod,
  value: unknown,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) {
    throw new ServiceError(
      408,
      "Worker request deadline exceeded or was cancelled"
    );
  }
  const input = requireRecord(value, `${method} input`);
  switch (method) {
    case "listStories": return await service.listStories();
    case "listStoriesPage": return await service.listStoriesPage(input);
    case "searchStories": return await service.searchStories(input, signal);
    case "loadStory":
      return await service.loadStory(requireString(input.id, "id"));
    case "getUnknownOutcomeStatus":
      return await service.getUnknownOutcomeStatus(
        requireString(input.storyId, "storyId"),
        requireString(
          input.originalProviderMutationId,
          "originalProviderMutationId"
        ),
        input.providerRecovery === undefined
          ? undefined
          : requireProviderRecoveryContext(input.providerRecovery)
      );
    case "previewChapterBreakRemoval": {
      const preview = await service.previewChapterBreakRemoval(
        requireString(input.storyId, "storyId"),
        requireString(input.breakId, "breakId")
      );
      return {
        removedFingerprint: preview.removedFingerprint,
        aggregateVersion: preview.aggregateVersion
      };
    }
    case "exportMarkdown":
      return await service.exportMarkdown(requireString(input.id, "id"));
    case "getTokenProbabilities":
      return await service.getTokenProbabilities(
        requireString(input.storyId, "storyId"),
        requireString(input.nodeId, "nodeId")
      );
    case "getGenerationRecords":
      return await service.getGenerationRecords(
        requireString(input.storyId, "storyId"),
        requireString(input.nodeId, "nodeId"),
        signal
      );
    case "getGenerationRecord":
      return await service.getGenerationRecord(
        requireString(input.storyId, "storyId"),
        requireString(input.nodeId, "nodeId"),
        requireString(input.recordId, "recordId"),
        signal
      );
    case "getReasoning":
      return await service.getReasoning(
        requireString(input.storyId, "storyId"),
        requireString(input.nodeId, "nodeId")
      );
    case "getSettings": return await service.getSettings();
    case "checkModelServer":
      return await service.checkModelServer(
        requireRecord(input.settings, "settings"),
        signal
      );
    case "probeContextWindow":
      return await service.probeContextWindow(
        requireRecord(input.settings, "settings"),
        signal
      );
    case "resolveSamplingBias":
      return await service.resolveSamplingBias(input, signal);
    case "discoverModels":
      return await service.discoverModels(
        requireRecord(input.settings, "settings"),
        signal
      );
    case "countPromptTokens":
      return await service.countPromptTokens(input.messages, signal);
    case "stageStoryImage": {
      requireImageInputEntryPointsOpen();
      const { storyId, mediaType, bytes } = parseStageStoryImageInput(input);
      return await withImageStagePermit(signal, async () =>
        await service.stageStoryImage(storyId, mediaType, bytes));
    }
    case "releaseStoryImage": {
      requireImageInputEntryPointsOpen();
      const storyId = requireString(input.storyId, "storyId");
      const leaseId = requireString(input.leaseId, "leaseId");
      return await withImageStagePermit(signal, async () => {
        await service.releaseStoryImage(storyId, leaseId);
        return { ok: true };
      });
    }
    default:
      throw new ServiceError(
        400,
        `${method} is not a read-only worker method`
      );
  }
}

function mutationOutcome(error: unknown): "terminal" | "uncertain" {
  const code = toPublicServiceError(error).code;
  if (
    code === "mutation_outcome_unknown"
    || code === "generation_outcome_unknown"
  ) {
    return "uncertain";
  }
  if (error instanceof ProviderError) {
    return "terminal";
  }
  if (error instanceof ServiceError) {
    return error.code === "internal" ? "uncertain" : "terminal";
  }
  return "uncertain";
}

async function executeWorkerMutationWithRetry(
  service: StoryService,
  message: WorkerRequest,
  onDelta: (text: string) => void,
  onReasoning: (delta: ReasoningStreamDelta) => void,
  cancellation: WorkerRequestCancellation
): Promise<unknown> {
  for (;;) {
    try {
      return await executeMutation(service, message, onDelta, onReasoning, cancellation.signal);
    } catch (error) {
      if (message.method !== "commitPartialRewrite"
        || !isRetryablePartialSettlementFailure(error)
        || cancellation.signal.aborted) {
        throw error;
      }
      await waitForPartialSettlementRetry(cancellation.signal);
      if (cancellation.signal.aborted) throw error;
    }
  }
}

async function waitForPartialSettlementRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, PARTIAL_SETTLEMENT_RETRY_MS);
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requireProviderRecoveryContext(value: unknown) {
  if (!isProviderRecoveryContext(value)) {
    throw new ServiceError(400, "providerRecovery is invalid");
  }
  return value;
}

/** Validate a `stageStoryImage` worker request's fields before any permit is
 *  acquired: `storyId`, a supported Source Image media type, and bytes that
 *  survived structured clone as an actual `Uint8Array`. Anything else is a
 *  protocol violation, and rebuilding bytes from an index object would hide
 *  the sender's bug (mirrors the `archiveBytes` check in
 *  server/worker-mutations.ts). */
function parseStageStoryImageInput(
  input: Readonly<Record<string, unknown>>
): { storyId: string; mediaType: SourceImageMediaType; bytes: Uint8Array } {
  const storyId = requireString(input.storyId, "storyId");
  const mediaType = input.mediaType;
  if (!isSourceImageMediaType(mediaType)) {
    throw new ServiceError(
      415,
      "mediaType must be image/png, image/jpeg, or image/webp",
      "image_type_not_supported"
    );
  }
  const bytes = input.bytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new ServiceError(400, "bytes must be a Uint8Array", "image_invalid");
  }
  return { storyId, mediaType, bytes };
}
