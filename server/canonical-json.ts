import { StoryFormatError } from "./story-format-facts.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
export { canonicalJson } from "../shared/canonical-json-core.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function decodeCanonicalUtf8(bytes: Uint8Array, label: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StoryFormatError(`${label} must not start with a UTF-8 BOM`);
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new StoryFormatError(`${label} is not valid UTF-8`, { cause: error });
  }
}

export function encodeUtf8Strict(text: string, label: string): Uint8Array {
  assertWellFormedString(text, label);
  return Buffer.from(text, "utf8");
}

export function assertNfcJsonStrings(value: unknown, label = "JSON value"): void {
  if (typeof value === "string") {
    assertWellFormedString(value, label);
    if (value.normalize("NFC") !== value) throw new StoryFormatError(`${label} must be NFC-normalized`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNfcJsonStrings(entry, `${label}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertWellFormedString(key, `${label} key`);
      if (key.normalize("NFC") !== key) throw new StoryFormatError(`${label} key must be NFC-normalized`);
      assertNfcJsonStrings(entry, `${label}.${key}`);
    }
  }
}

export function assertWellFormedString(value: string, label: string): void {
  if (hasUnpairedSurrogate(value)) throw new StoryFormatError(`${label} has an unpaired Unicode surrogate`);
}
