import { createHash } from "node:crypto";
import { requireMutationId } from "./mutation-ledger-scalars.js";
import type { StoryId } from "./story-v6-types.js";

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

/** Deterministic create/import identity. */
export function storyIdForMutation(mutationIdValue: unknown): StoryId {
  const mutationId = requireMutationId(mutationIdValue);
  const digest = createHash("sha256")
    .update("story-v1\0", "utf8")
    .update(mutationId, "utf8")
    .digest();
  return `st1_${base32LowerNoPad(digest)}`;
}

function base32LowerNoPad(bytes: Uint8Array): string {
  let accumulator = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += BASE32_LOWER[(accumulator >>> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) encoded += BASE32_LOWER[(accumulator << (5 - bitCount)) & 0x1f];
  return encoded;
}
