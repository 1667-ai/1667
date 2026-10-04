import {
  validateSamplingLogitBiasEntry
} from "./sampling-validation-policy.js";

/** The text forms of the sampling lists, for a surface that edits a list as
 * lines: the terminal edits one entry at a time with the same line rules, the
 * web edits all lines of a list in one field. Format only. The validation of
 * the whole value stays with `validateSamplingSettings`. */

/** One `token ID:integer bias` entry, or the reason it is refused. */
export function parseLogitBiasEntry(
  raw: string
): { readonly token: string; readonly weight: number } | { readonly error: string } {
  const divider = raw.indexOf(":");
  if (divider <= 0) return { error: "use token ID:integer bias" };
  const token = raw.slice(0, divider).trim();
  const weightText = raw.slice(divider + 1).trim();
  if (!/^-?\d+$/u.test(weightText)) return { error: "bias must be an integer" };
  const weight = Number(weightText);
  try {
    validateSamplingLogitBiasEntry(token, weight, "logit bias");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { token, weight };
}

export function formatLogitBiasText(bias: Readonly<Record<string, number>>): string {
  return Object.entries(bias).map(([token, weight]) => `${token}:${weight}`).join("\n");
}

export function parseLogitBiasText(
  text: string
): { readonly value: Record<string, number> } | { readonly error: string } {
  const value: Record<string, number> = {};
  for (const line of lines(text)) {
    const entry = parseLogitBiasEntry(line);
    if ("error" in entry) return { error: `${JSON.stringify(line)}: ${entry.error}` };
    if (Object.hasOwn(value, entry.token)) return { error: "token ID already exists" };
    value[entry.token] = entry.weight;
  }
  return { value };
}

/** The non-empty lines. A line keeps its own spaces: a stop sequence may
 * start or end with one. */
export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

/** An entry as one line of text: a newline, a tab, a carriage return and a
 * backslash are written as `\n`, `\t`, `\r` and `\\`, so an entry such as a
 * single newline survives the round trip. */
export function encodeListEntry(entry: string): string {
  return entry.replace(/[\\\n\t\r]/gu, (char) => (
    char === "\\" ? "\\\\" : char === "\n" ? "\\n" : char === "\t" ? "\\t" : "\\r"
  ));
}

export function decodeListEntry(line: string): string {
  return line.replace(/\\([\\ntr])/gu, (_match, code: string) => (
    code === "n" ? "\n" : code === "t" ? "\t" : code === "r" ? "\r" : "\\"
  ));
}

/** The entries of a list written one per line with those escapes. */
export function decodeListLines(text: string): string[] {
  return lines(text).map(decodeListEntry);
}
