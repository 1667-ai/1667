import {
  isWorkerInstanceId,
  isWorkerOperationId,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import { isBuildIdentity } from "../../shared/build-identity.js";

export function isWorkerMessage(value: unknown): value is WorkerToMainMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "stopped") return true;
  if (message.type === "starting" || message.type === "ready") {
    return Number.isSafeInteger(message.protocolVersion)
      && isBuildIdentity(message.buildIdentity)
      && isWorkerInstanceId(message.workerInstanceId);
  }
  if (message.type === "protocolError") return typeof message.message === "string";
  if (!isWorkerOperationId(message.id)) return false;
  if (message.type === "result" || message.type === "complete") return "value" in message;
  if (message.type === "operation") {
    return (message.state === "running"
      || message.state === "completed"
      || message.state === "canceled"
      || message.state === "failed"
      || message.state === "unknown")
      && message.terminal === (message.state !== "running");
  }
  if (message.type === "delta") {
    return Number.isSafeInteger(message.sequence) && (message.sequence as number) >= 0
      && typeof message.text === "string";
  }
  if (message.type !== "error" || typeof message.code !== "string" || typeof message.message !== "string") {
    return false;
  }
  if (message.mutationOutcome !== undefined
    && message.mutationOutcome !== "terminal" && message.mutationOutcome !== "uncertain") return false;
  if (message.details === undefined) return true;
  if (message.details === null || typeof message.details !== "object") return false;
  const status = (message.details as Record<string, unknown>).status;
  return status === undefined || Number.isSafeInteger(status);
}

export function isShutdownTerminalMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { type?: unknown }).type === "stopped";
}
