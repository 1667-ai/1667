import {
  MUTATION_INPUT_PROTOCOL_VERSION,
  type MutatingWorkerMethod,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { StoryService } from "./story-service.js";
import { ServiceError } from "./errors.js";
import { storyIdForMutation } from "./story-identity.js";
import { mutationFingerprint } from "./mutation-receipts.js";
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
  onDelta: (text: string) => void = () => {}
): Promise<WorkerOutput<M>> {
  let parsed: ReturnType<typeof parseWorkerMutation<M>> | undefined;
  const parse = () => parsed ??= parseWorkerMutation(
    method,
    input,
    MUTATION_INPUT_PROTOCOL_VERSION
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
          MUTATION_INPUT_PROTOCOL_VERSION
        ),
        scope: `story:${storyId}` as const,
        expectedAggregateVersion
      };
      return executeWorkerMutation(service, parsedInput, plan, {
        onDelta,
        signal,
        storyMutationRequest
      });
    },
    MUTATION_INPUT_PROTOCOL_VERSION,
    () => undefined
  );
}
