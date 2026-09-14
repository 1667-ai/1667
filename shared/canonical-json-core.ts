import { StoryFormatError } from "./story-format-errors.js";
import { hasUnpairedSurrogate } from "./unicode.js";

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

function assertWellFormedString(value: string, label: string): void {
  if (hasUnpairedSurrogate(value)) throw new StoryFormatError(`${label} has an unpaired Unicode surrogate`);
}
