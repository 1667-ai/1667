import type { WorkerInput } from "../shared/worker-protocol.js";
import { ServiceError } from "./errors.js";
import { requireRecord } from "./validation.js";

/** Project the nested continuation target into its closed protocol shape. The
 * outer instruction and genId remain authoritative mutation-envelope fields. */
export function parseWorkerContinueTarget(
  value: unknown
): WorkerInput<"continueStory">["target"] {
  const target = requireRecord(value, "target");
  for (const [key, child] of Object.entries(target)) {
    if (child === undefined) continue;
    switch (key) {
      case "parentId":
      case "appendTo":
      case "expectedTextHash":
        break;
      default:
        throw badTarget(`target.${key} is not supported`);
    }
  }
  if (target.parentId !== undefined
    && target.parentId !== null
    && typeof target.parentId !== "string") {
    throw badTarget("target.parentId must be a string or null");
  }
  return {
    ...(target.parentId === undefined ? {} : { parentId: target.parentId }),
    ...(target.appendTo === undefined
      ? {}
      : { appendTo: targetString(target.appendTo, "target.appendTo") }),
    ...(target.expectedTextHash === undefined
      ? {}
      : { expectedTextHash: targetString(target.expectedTextHash, "target.expectedTextHash") })
  };
}

function targetString(value: unknown, label: string): string {
  if (typeof value !== "string") throw badTarget(`${label} must be a string`);
  return value;
}

function badTarget(message: string): ServiceError {
  return new ServiceError(400, message);
}
