import {
  FactActivationError,
  MAX_FACT_KEYS,
  assertFactKeyText
} from "./fact-metadata.js";
import { compileFactPattern } from "./fact-pattern.js";

/** A slash pattern must have a closing unescaped slash. `/home/user` remains literal. */
export function isRegexKey(value: string): boolean {
  return splitRegexKey(value) !== null;
}
export function splitRegexKey(
  value: string
): { source: string; flags: string } | null {
  if (!value.startsWith("/")) return null;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value[index] === "\\") {
      escaped = true;
      continue;
    }
    if (value[index] === "/") {
      const flags = value.slice(index + 1);
      // Match SillyTavern's marker rule: a later unescaped slash or prose
      // suffix means this is a literal key. Known-but-unsupported flags stay
      // a pattern so validation can give the writer a useful error.
      if (!/^[dgimsuvy]*$/u.test(flags)) return null;
      return { source: value.slice(1, index), flags };
    }
  }
  return null;
}
export function parseFactKeys(value: unknown, label = "Fact keys"): string[] {
  if (!Array.isArray(value)) throw new FactActivationError(`${label} must be an array`);
  if (value.length > MAX_FACT_KEYS) {
    throw new FactActivationError(`${label} exceeds the ${MAX_FACT_KEYS}-key limit`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof candidate !== "string") {
      throw new FactActivationError(`${itemLabel} must be a string`);
    }
    assertFactKeyText(candidate, itemLabel);
    const pattern = splitRegexKey(candidate);
    if (pattern === null) {
      if (candidate.includes(",")) {
        throw new FactActivationError(`${itemLabel} must not contain a comma`);
      }
      const identity = `l:${candidate.normalize("NFC").toLowerCase()}`;
      if (seen.has(identity)) {
        throw new FactActivationError(`${itemLabel} duplicates another key`);
      }
      seen.add(identity);
    } else {
      compileFactPattern(pattern.source, pattern.flags, itemLabel);
      const identity = `r:${candidate}`;
      if (seen.has(identity)) {
        throw new FactActivationError(`${itemLabel} duplicates another key`);
      }
      seen.add(identity);
    }
    return candidate;
  });
}
/** Split editor text without treating commas inside a closed slash pattern as separators. */
export function splitFactKeyLine(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let pattern = value.startsWith("/");
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const scalar = value[index]!;
    if (pattern) {
      if (index === start) continue;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (scalar === "\\") {
        escaped = true;
        continue;
      }
      if (scalar === "/") {
        pattern = false;
        continue;
      }
    }
    if (scalar === "," && !pattern) {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
      while (value[start] === " ") start += 1;
      pattern = value[start] === "/";
    }
  }
  // An unclosed candidate is intentionally re-read as literals. Earlier
  // closed patterns stay intact, including their quantifier commas.
  if (pattern) {
    return [...entries, ...value.slice(start).split(",").map((entry) => entry.trim())];
  }
  entries.push(value.slice(start).trim());
  return entries;
}
export function formatFactKeyLine(keys: readonly string[]): string {
  return keys.join(", ");
}
