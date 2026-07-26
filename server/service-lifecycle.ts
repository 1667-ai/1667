import { ServiceError } from "./errors.js";

type ServiceState = "new" | "initializing" | "ready" | "closing" | "closed";

/** Serializes service startup and shutdown, and keeps operations behind the
 * initialization boundary that establishes storage ownership. */
export class ServiceLifecycle {
  private state: ServiceState = "new";
  private initialization: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;

  async init(initialize: () => Promise<void>): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "closing" || this.state === "closed") throw shuttingDown();
    if (this.state === "initializing") {
      await this.initialization;
      this.assertReady();
      return;
    }

    this.state = "initializing";
    const initialization = Promise.resolve().then(initialize);
    this.initialization = initialization;
    try {
      await initialization;
      if (this.state === "initializing") this.state = "ready";
    } catch (error) {
      if (this.state === "initializing") this.state = "new";
      throw error;
    } finally {
      if (this.initialization === initialization) this.initialization = null;
    }
    this.assertReady();
  }

  async dispose(dispose: () => Promise<void>): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "closing") {
      await this.disposal;
      return;
    }

    this.state = "closing";
    const initialization = this.initialization;
    const disposal = (async () => {
      try {
        await initialization?.catch(() => undefined);
        await dispose();
      } finally {
        this.state = "closed";
      }
    })();
    this.disposal = disposal;
    try {
      await disposal;
    } finally {
      if (this.disposal === disposal) this.disposal = null;
    }
  }

  assertReady(): void {
    if (this.state === "ready") return;
    if (this.state === "new" || this.state === "initializing") {
      throw new ServiceError(
        503,
        "Story service is not initialized",
        "resource_busy"
      );
    }
    throw shuttingDown();
  }
}

function shuttingDown(): ServiceError {
  return new ServiceError(
    503,
    "Story service is shutting down",
    "resource_busy"
  );
}
