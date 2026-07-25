import { startHttpListener } from "./http-listener.js";
import { runHttpListenerUntilSignal } from "./http-process-lifecycle.js";

await runHttpListenerUntilSignal(
  async () => await startHttpListener({
    port: Number(process.env.AI_1667_PORT ?? 7373),
    developmentOrigin: process.argv.includes("--dev")
      ? process.env.AI_1667_DEV_ORIGIN ?? "http://127.0.0.1:5173"
      : null
  }),
  (listener) => {
    console.log(
      `1667 listening on ${listener.origin} (data: ${listener.dataDir})`
    );
  }
);
