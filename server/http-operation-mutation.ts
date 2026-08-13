import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  PRE_ASIDE_WORKER_PROTOCOL_VERSION,
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
  onReasoning: (delta: ReasoningStreamDelta) => void | Promise<void> = () => {}
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
        storyMutationRequest
      });
    },
    protocolVersion,
    () => undefined
  );
}

/** A protocol bump added Aside methods in v11. Keep an exact HTTP retry of a
 * retained v10 receipt on the protocol that created its fingerprint and
 * parsed its input. New mutations and all Aside methods stay on v11. */
async function acceptedHttpMutationProtocolVersion(
  service: StoryService,
  mutationId: string,
  method: MutatingWorkerMethod
): Promise<number> {
  const receipt = await service.inspectMutationReceipt(mutationId, method);
  return receipt !== null
    && receipt.method === method
    && receipt.protocolVersion === PRE_ASIDE_WORKER_PROTOCOL_VERSION
    && method !== "askAside"
    && method !== "clearAside"
    ? PRE_ASIDE_WORKER_PROTOCOL_VERSION
    : MUTATION_INPUT_PROTOCOL_VERSION;
}
