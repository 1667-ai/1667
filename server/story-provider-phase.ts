import { ServiceError } from "./errors.js";
import type {
  MutationCoordinator,
  MutationCoordinatorRequest,
  StoryMutationTarget
} from "./mutation-coordinator.js";

const TERMINAL_CLAIM_TIMEOUT_MS = 5_000;
const TERMINAL_CLAIM_RETRY_MS = 10;

/** A provider result already exists in memory, so brief ordinary contention
 * must not turn it into an unknown outcome. Keep admission itself fail-fast,
 * but retry this one short terminal publication for a bounded interval. */
export async function runTerminalStoryPhase<Result>(
  coordinator: MutationCoordinator,
  request: MutationCoordinatorRequest<StoryMutationTarget>,
  handler: () => Result | PromiseLike<Result>
): Promise<Result> {
  const deadline = performance.now() + TERMINAL_CLAIM_TIMEOUT_MS;
  while (true) {
    let entered = false;
    try {
      return await coordinator.runStoryPhase(request, async () => {
        entered = true;
        return await handler();
      });
    } catch (error) {
      if (!(error instanceof ServiceError)
        || error.code !== "resource_busy"
        || entered
        || performance.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TERMINAL_CLAIM_RETRY_MS)
      );
    }
  }
}
