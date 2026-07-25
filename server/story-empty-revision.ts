import { createHash } from "node:crypto";

/** A migration-only empty endpoint can be decoded before this deterministic
 * revision object is materialized by the first V4 save. */
export const SYNTHETIC_EMPTY_REVISION_RAW =
  '{"format":"1667-text-revision","schemaVersion":1,"chunks":[],"utf16Length":0}';
export const SYNTHETIC_EMPTY_REVISION_ID = createHash("sha256")
  .update(SYNTHETIC_EMPTY_REVISION_RAW)
  .digest("hex");
