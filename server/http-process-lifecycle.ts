import type { HttpListener } from "./http-listener.js";

/** Own one process listener from pre-bind startup through signal-driven close. */
export async function runHttpListenerUntilSignal(
  start: () => Promise<HttpListener>,
  onReady: (listener: HttpListener) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let startup!: Promise<HttpListener>;
    let stopping = false;
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (error === undefined) resolve();
      else reject(error);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void startup.then((listener) => listener.close()).then(
        () => finish(),
        (error: unknown) => finish(error)
      );
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      startup = start();
    } catch (error) {
      finish(error);
      return;
    }
    void startup.then((listener) => {
      if (stopping) return;
      try {
        onReady(listener);
      } catch (error) {
        stopping = true;
        void listener.close().then(
          () => finish(error),
          (cleanupError: unknown) => finish(new AggregateError(
            [error, cleanupError],
            "1667 listener ready callback and cleanup both failed",
            { cause: error }
          ))
        );
      }
    }, (error: unknown) => finish(error));
  });
}
