import {
  DATA_DIRECTORY_ID_FILE,
  DATA_DIRECTORY_ID_SCRATCH,
  HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES
} from "./data-directory-layout.js";

const MANAGED_IGNORE_STATES = new Map<string, boolean>([
  [DATA_DIRECTORY_ID_FILE, false],
  [DATA_DIRECTORY_ID_SCRATCH, true],
  ...HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES.map(
    (entry) => [entry, true] as const
  )
]);

export function managedProjectIgnoreStatesAreEffective(
  suffix: Buffer
): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(suffix);
  } catch {
    return false;
  }
  const states = new Map(MANAGED_IGNORE_STATES);
  for (const rawLine of text.split("\n")) {
    const rule = parseGitIgnoreRule(rawLine.replace(/\r$/, ""));
    if (rule === null) continue;
    const pattern = compileGitIgnorePattern(rule.pattern);
    if (pattern === null) return false;
    if (pattern === false) continue;
    for (const entry of states.keys()) {
      if (gitIgnorePatternMatches(pattern, entry)) {
        states.set(entry, !rule.negated);
      }
    }
  }
  return [...MANAGED_IGNORE_STATES].every(
    ([entry, ignored]) => states.get(entry) === ignored
  );
}

function parseGitIgnoreRule(
  rawLine: string
): { readonly pattern: string; readonly negated: boolean } | null {
  let line = trimGitIgnoreSpaces(rawLine);
  if (line === "" || line.startsWith("#")) return null;
  const negated = line.startsWith("!");
  if (negated) line = line.slice(1);
  if (line === "" || line.endsWith("/")) return null;
  return { pattern: line, negated };
}

function trimGitIgnoreSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let slashes = 0;
    for (
      let cursor = end - 2;
      cursor >= 0 && value[cursor] === "\\";
      cursor--
    ) {
      slashes += 1;
    }
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function compileGitIgnorePattern(
  patternInput: string
): string | false | null {
  let pattern = patternInput.startsWith("/")
    ? patternInput.slice(1)
    : patternInput;
  while (pattern.startsWith("**/")) pattern = pattern.slice(3);
  if (pattern.includes("/")) return false;
  if (/[A-Z]/u.test(pattern)) return null;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      if (pattern[index + 1] === undefined) return null;
      index += 1;
    } else if (character === "[") {
      return null;
    }
  }
  return pattern;
}

function gitIgnorePatternMatches(
  pattern: string,
  entry: string
): boolean {
  let patternIndex = 0;
  let entryIndex = 0;
  let starResumeIndex = -1;
  let starEntryIndex = -1;
  while (entryIndex < entry.length) {
    const token = readGitIgnoreToken(pattern, patternIndex);
    if (token.kind === "any"
      || (token.kind === "literal"
        && token.value === entry[entryIndex])) {
      patternIndex = token.nextIndex;
      entryIndex += 1;
      continue;
    }
    if (token.kind === "star") {
      patternIndex = token.nextIndex;
      while (pattern[patternIndex] === "*") patternIndex += 1;
      starResumeIndex = patternIndex;
      starEntryIndex = entryIndex;
      continue;
    }
    if (starResumeIndex < 0) return false;
    patternIndex = starResumeIndex;
    starEntryIndex += 1;
    entryIndex = starEntryIndex;
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function readGitIgnoreToken(
  pattern: string,
  index: number
):
  | { readonly kind: "end" }
  | { readonly kind: "star"; readonly nextIndex: number }
  | { readonly kind: "any"; readonly nextIndex: number }
  | {
      readonly kind: "literal";
      readonly value: string;
      readonly nextIndex: number;
    } {
  const character = pattern[index];
  if (character === undefined) return { kind: "end" };
  if (character === "*") return { kind: "star", nextIndex: index + 1 };
  if (character === "?") return { kind: "any", nextIndex: index + 1 };
  if (character === "\\") {
    return {
      kind: "literal",
      value: pattern[index + 1]!,
      nextIndex: index + 2
    };
  }
  return { kind: "literal", value: character, nextIndex: index + 1 };
}
