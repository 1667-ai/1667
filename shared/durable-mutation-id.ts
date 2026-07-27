const MUTATION_ENTROPY_BYTES = 16;
const THIRTEEN_DIGIT_MIN = 1_000_000_000_000;
const THIRTEEN_DIGIT_MAX = 9_999_999_999_999;

export interface RandomByteSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * Durable mutation identity. This is intentionally distinct from a
 * transport request ID and from the legacy worker outbox's `m1-...` IDs.
 */
export function createDurableMutationId(
  now = Date.now(),
  random: RandomByteSource = globalThis.crypto
): string {
  if (!Number.isSafeInteger(now) || now < THIRTEEN_DIGIT_MIN || now > THIRTEEN_DIGIT_MAX) {
    throw new Error("Durable mutation timestamp must be a 13-digit integer");
  }
  const entropy = random.getRandomValues(new Uint8Array(MUTATION_ENTROPY_BYTES));
  const hex = [...entropy].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `m1.${now}.${hex}`;
}
