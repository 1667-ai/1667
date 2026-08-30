import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

/** Maximum number of Unicode scalar values in a Fact name. */
export const MAX_FACT_NAME_CHARS = 4_096;

/**
 * Normalize the optional Fact name at every input boundary.
 *
 * `undefined`, `null`, and whitespace-only values mean that the name is not
 * set. Non-empty values are trimmed, NFC-normalized, and retained. The
 * function throws a plain Error so server and wire decoders can map it to
 * their own boundary error.
 */
export function normalizeFactName(value: unknown, label = "Fact name"): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  const trimmed = value.trim();
  if (hasUnpairedSurrogate(trimmed)) throw new Error(`${label} contains invalid Unicode`);
  const name = trimmed.normalize("NFC");
  if (unicodeScalarLength(name, MAX_FACT_NAME_CHARS) > MAX_FACT_NAME_CHARS) {
    throw new Error(`${label} exceeds the ${MAX_FACT_NAME_CHARS}-character limit`);
  }
  return name.length === 0 ? undefined : name;
}
