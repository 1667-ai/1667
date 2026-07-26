import type { HttpListener } from "./http-listener.js";

/** Own one process listener from pre-bind startup through signal-driven close.
 * A signal always starts shutdown, even if advisory readiness work stalls. */
export async function runHttpListenerUntilSignal(
  start: () => Promise<HttpListener>,
  onReady: (
    listener: HttpListener,
    signal: AbortSignal
  ) => void | Promise<void>
): Promise<void> {
  let stopRequested = false;
  const stopController = new AbortController();
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    stopController.abort();
    resolveSignal();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const listener = await start();
    if (!stopRequested) {
      const readiness = Promise.resolve().then(async () =>
        await onReady(listener, stopController.signal));
      listener.trackReadiness(readiness, stopController.signal);
      const outcome = await Promise.race([
        readiness.then(
          () => ({ kind: "ready" as const }),
          (error: unknown) => ({ kind: "failure" as const, error })
        ),
        signal.then(() => ({ kind: "stopped" as const }))
      ]);
      if (outcome.kind === "stopped") {
        await listener.close();
        return;
      }
      if (outcome.kind === "failure") {
        await listener.close();
        throw outcome.error;
      }
    }
    if (!stopRequested) await signal;
    await listener.close();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
