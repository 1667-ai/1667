import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION,
  PRE_ASIDE_WORKER_PROTOCOL_VERSION,
  PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION,
  type MutatingWorkerMethod,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { StoryService } from "./story-service.js";
import { ServiceError } from "./errors.js";
import { storyIdForMutation } from "./story-identity.js";
import { mutationFingerprint } from "./mutation-receipts.js";
import type { ReasoningStreamDelta } from "./providers.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  storyIdForWorkerMutation
} from "./worker-mutations.js";

/** Runs HTTP mutations through the same durable receipt boundary. */
export async function runHttpOperationMutation<
  M extends MutatingWorkerMethod
>(
  service: StoryService,
  mutationId: string,
  method: M,
  input: unknown,
  signal: AbortSignal,
  transportOperationId: string,
  expectedAggregateVersion: StoryAggregateVersion,
  onDelta: (text: string) => void | Promise<void> = () => {},
  onReasoning: (delta: ReasoningStreamDelta) => void | Promise<void> = () => {},
  canCommitStoppedAside?: () => boolean
): Promise<WorkerOutput<M>> {
  const protocolVersion = await acceptedHttpMutationProtocolVersion(
    service,
    mutationId,
    method
  );
  let parsed: ReturnType<typeof parseWorkerMutation<M>> | undefined;
  const parse = () => parsed ??= parseWorkerMutation(
    method,
    input,
    protocolVersion
  );
  return await service.runMutation(
    mutationId,
    method,
    input,
    (plan) => {
      const parsedInput = parse();
      const storyId = expectedAggregateVersion.kind === "absent"
        ? storyIdForMutation(mutationId)
        : storyIdForWorkerMutation(parsedInput, plan);
      if (storyId === null) {
        throw new ServiceError(
          500,
          `HTTP story mutation ${method} has no aggregate target`
        );
      }
      const storyMutationRequest = {
        transportOperationId,
        mutationId,
        fingerprint: mutationFingerprint(
          method,
          input,
          protocolVersion
        ),
        scope: `story:${storyId}` as const,
        expectedAggregateVersion
      };
      return executeWorkerMutation(service, parsedInput, plan, {
        onDelta,
        onReasoning,
        signal,
        ...(canCommitStoppedAside === undefined
          ? {}
          : { canCommitStoppedAside }),
        storyMutationRequest
      });
    },
    protocolVersion,
    () => undefined
  );
}

/** Keep an exact HTTP retry on the retained protocol that created its
 * fingerprint and parsed its input. Protocol 10 predates Aside. Protocol 11
 * predates Settings schema 5. Protocol 12 predates edited Aside retakes. New
 * mutations use the current protocol. */
async function acceptedHttpMutationProtocolVersion(
  service: StoryService,
  mutationId: string,
  method: MutatingWorkerMethod
): Promise<number> {
  const receipt = await service.inspectMutationReceipt(mutationId, method);
  const retainedProtocol = receipt !== null && "protocolVersion" in receipt
    ? receipt.protocolVersion
    : null;
  const retainedPreAside = retainedProtocol === PRE_ASIDE_WORKER_PROTOCOL_VERSION
    && method !== "askAside"
    && method !== "clearAside";
  return receipt !== null
    && receipt.method === method
    && (retainedPreAside
      || retainedProtocol === PRE_SETTINGS_SCHEMA5_WORKER_PROTOCOL_VERSION
      || retainedProtocol === PRE_ASIDE_REPROMPT_WORKER_PROTOCOL_VERSION)
    ? retainedProtocol
    : MUTATION_INPUT_PROTOCOL_VERSION;
}
