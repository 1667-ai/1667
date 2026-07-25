import { startHttpListener } from "./http-listener.js";
import { runHttpListenerUntilSignal } from "./http-process-lifecycle.js";
import { announceProjectServer } from "./project-run-record.js";
import { StoryService } from "./story-service.js";

await runHttpListenerUntilSignal(
  async () => await startHttpListener({
    port: Number(process.env.AI_1667_PORT ?? 0),
    developmentOrigin: process.argv.includes("--dev")
      ? process.env.AI_1667_DEV_ORIGIN ?? "http://127.0.0.1:5173"
      : null,
    // Only the product entry point fills a new data directory. Callers that
    // embed the listener as a library keep getting an empty one.
    serviceFactory: async () => new StoryService({ starterVault: "seed-when-new" })
  }),
  (listener) => {
    void announceProjectServer(listener.dataDir, {
      port: Number(new URL(listener.origin).port),
      url: listener.origin
    });
    console.log(
      `1667 listening on ${listener.origin} (data: ${listener.dataDir})`
    );
  }
);
