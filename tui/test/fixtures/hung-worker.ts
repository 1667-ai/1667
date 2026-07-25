import {
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION
} from "../../../shared/worker-protocol.js";

postMessage({
  type: "ready",
  protocolVersion: WORKER_PROTOCOL_VERSION,
  buildIdentity: WORKER_BUILD_IDENTITY,
  workerInstanceId: "1".repeat(32)
});
setInterval(() => {}, 60_000);
