const MUTATION_ENTROPY_BYTES = 16;
const THIRTEEN_DIGIT_MIN = 1_000_000_000_000;
const THIRTEEN_DIGIT_MAX = 9_999_999_999_999;

export const DURABLE_MUTATION_ID_PATTERN_SOURCE =
  "m1\\.[0-9]{13}\\.[a-f0-9]{32}";
export const DURABLE_MUTATION_ID_PATTERN = new RegExp(
  `^(?:${DURABLE_MUTATION_ID_PATTERN_SOURCE})(?![\\s\\S])`
);

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

export function isDurableMutationId(
  value: unknown
): value is string {
  return typeof value === "string"
    && DURABLE_MUTATION_ID_PATTERN.test(value);
}

export function durableMutationTimestampMs(
  value: unknown
): number | null {
  return isDurableMutationId(value)
    ? Number(value.slice(3, 16))
    : null;
}
