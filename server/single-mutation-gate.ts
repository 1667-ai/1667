import { ServiceError } from "./errors.js";
import type { HttpMutationGate } from "./http-router.js";

/** Legacy HTTP mode admits exactly one mutation and never queues another. */
export class SingleMutationGate implements HttpMutationGate {
  private active = false;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) {
      throw new ServiceError(
        409,
        "Legacy 1667 already has a mutation in flight",
        "resource_busy"
      );
    }
    this.active = true;
    try {
      return await work();
    } finally {
      this.active = false;
    }
  }
}
