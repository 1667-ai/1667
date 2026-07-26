import { PublicRuntimeError } from "./errors.js";
import { StoragePathNotDirectoryError } from "./story-lifecycle.js";

/**
 * Expose actionable local configuration failures only at startup boundaries.
 * Request-time storage failures continue through the private error policy.
 */
export function localStartupFailure(error: unknown): unknown {
  if (error instanceof PublicRuntimeError) return error;
  return error instanceof StoragePathNotDirectoryError
    ? new PublicRuntimeError(error.message, { cause: error })
    : error;
}
