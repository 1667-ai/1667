import type {
  WorkerToMainMessage
} from "../../../shared/worker-protocol.js";

export function nextWorkerMessage(
  worker: Worker
): Promise<WorkerToMainMessage> {
  return new Promise((resolve) => {
    worker.addEventListener("message", (event) => {
      resolve(event.data as WorkerToMainMessage);
    }, { once: true });
  });
}

export function nextWorkerMessageOfType<
  T extends WorkerToMainMessage["type"]
>(
  worker: Worker,
  type: T
): Promise<Extract<WorkerToMainMessage, { type: T }>> {
  return new Promise((resolve) => {
    const listener = ((event: MessageEvent<WorkerToMainMessage>) => {
      if (event.data.type !== type) return;
      worker.removeEventListener("message", listener);
      resolve(event.data as Extract<WorkerToMainMessage, { type: T }>);
    }) as EventListener;
    worker.addEventListener("message", listener);
  });
}
