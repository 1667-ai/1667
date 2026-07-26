import { startHttpListener } from "./http-listener.js";
import { runHttpListenerUntilSignal } from "./http-process-lifecycle.js";
import { StoryService } from "./story-service.js";
import {
  internalErrorReference,
  toPublicServiceError
} from "./service-error-policy.js";

try {
  await runHttpListenerUntilSignal(
    async () => await startHttpListener({
      port: Number(process.env.AI_1667_PORT ?? 0),
      developmentOrigin: process.argv.includes("--dev")
        ? process.env.AI_1667_DEV_ORIGIN ?? "http://127.0.0.1:5173"
        : null,
      printLogs: process.argv.includes("--print-logs"),
      // Only the product entry point fills a new data directory. Embedded
      // listeners keep getting an empty one. The factory receives the exact
      // machine tier already validated for auth and diagnostics.
      serviceFactory: async (errorReporter, machineDir) => new StoryService({
        machineDir,
        errorReporter,
        starterVault: "seed-when-new"
      })
    }),
    async (listener, signal) => {
      await listener.announceProjectServer(signal);
      if (!signal.aborted) {
        console.log(
          `1667 listening on ${listener.origin} (data: ${listener.dataDir})`
        );
      }
    }
  );
} catch (error) {
  const message = toPublicServiceError(error).message;
  const reference = internalErrorReference(error);
  process.stderr.write(
    `1667: ${message}${reference === null ? "" : ` (${reference})`}\n`
  );
  process.exitCode = 1;
}
