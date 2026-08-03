import { StoryFormatError } from "./story-format-facts.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";

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

/** RFC 8785 uses ECMAScript number/string serialization and UTF-16 key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") assertWellFormedString(value, "JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoryFormatError("Canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new StoryFormatError("Canonical JSON cannot encode a sparse array");
      entries.push(canonicalJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // A typed array has no canonical JSON form. Falling to the object branch
    // below would index it byte by byte, so a 20 MB file becomes twenty
    // million sorted string keys and a wrong, enormous encoding — silently.
    // A caller that means to carry bytes hashes them or encodes them first.
    throw new StoryFormatError("Canonical JSON cannot encode binary data");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      assertWellFormedString(key, "JSON object key");
      const entry = record[key];
      if (entry === undefined) throw new StoryFormatError(`Canonical JSON key ${key} has an undefined value`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    }).join(",")}}`;
  }
  throw new StoryFormatError(`Canonical JSON cannot encode ${typeof value}`);
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
