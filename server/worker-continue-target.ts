import type { WorkerInput } from "../shared/worker-protocol.js";
import { isDraftImageLeaseId, MAX_ACTIVE_PROMPT_IMAGES, type DraftImageReference } from "../shared/image-attachment.js";
import { ServiceError } from "./errors.js";
import { HASH_PATTERN } from "./story-format.js";
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

/** Parse the `continueStory` input's own `images` field: ordered
 * `{leaseId, objectId}` pairs beside `instruction` and `genId`, never inside
 * `target` (settled decision D6: `target` is a closed union about append
 * versus parent). Absent means no new Draft Images. Grammar only: whether a
 * lease is actually live, and whether its `objectId` matches, is a story
 * `ioQueue` question the server answers later, never here. */
export function parseWorkerContinueImages(value: unknown): readonly DraftImageReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badTarget("images must be an array");
  if (value.length > MAX_ACTIVE_PROMPT_IMAGES) {
    throw badTarget(`images holds more than ${MAX_ACTIVE_PROMPT_IMAGES} entries`);
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `images[${index}]`);
    const leaseId = record.leaseId;
    const objectId = record.objectId;
    if (typeof leaseId !== "string" || !isDraftImageLeaseId(leaseId)) {
      throw badTarget(`images[${index}].leaseId is invalid`);
    }
    if (typeof objectId !== "string" || !HASH_PATTERN.test(objectId)) {
      throw badTarget(`images[${index}].objectId is invalid`);
    }
    for (const key of Object.keys(record)) {
      if (key !== "leaseId" && key !== "objectId") {
        throw badTarget(`images[${index}].${key} is not supported`);
      }
    }
    return { leaseId, objectId };
  });
}
