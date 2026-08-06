import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

/** The state every file-path prompt keeps.
 *
 * The card import and the archive import ask the same question, so they share
 * one shape and one completion behaviour. A second copy would drift. */
export interface FilePathPrompt {
  path: string;
  /** Frozen at prompt-open so a story swap during the file read cannot
   * retarget the import at whichever story became current. */
  storyId: string;
  /** Candidates from the last tab press; display only, never a focus stop. */
  candidates: string[];
  error: string | null;
  returnMode: "NAV" | "COMPOSE";
}

/** The filesystem completion fields shared by every file-path prompt. */
export type FilePathCompletionPrompt = Pick<FilePathPrompt, "path" | "candidates" | "error">;

/** Extend the typed path to the longest match, and name the rest. */
export async function completeFilePath(prompt: FilePathCompletionPrompt): Promise<void> {
  const target = completionTarget(prompt.path);
  prompt.candidates = [];
  prompt.error = null;
  try {
    const entries = await readdir(target.directory, { withFileTypes: true });
    // macOS and Windows open `MIra.json` when the file is `mira.json`, so
    // completion that only matched exact case would report no match for a path
    // that imports fine.
    const wanted = target.base.toLowerCase();
    const matches = entries
      .filter((entry) => entry.name.toLowerCase().startsWith(wanted))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matches.length === 0) {
      prompt.error = "no file matches that path";
      return;
    }
    const names = matches.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    // Matches that differ only in case share no prefix. Completion extends what
    // the writer typed; it never takes characters away.
    const shared = longestCommonPrefix(names);
    prompt.path = target.prefix
      + ([...shared].length > [...target.base].length ? shared : target.base);
    if (matches.length > 1) prompt.candidates = names;
  } catch (error) {
    prompt.error = errorMessage(error);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completionTarget(typed: string): {
  directory: string;
  base: string;
  prefix: string;
} {
  const directoryInput = typed === "~" || /[\\/]$/u.test(typed);
  const expanded = typed === "~"
    ? `${homedir()}${sep}`
    : expandLeadingTilde(typed);
  const base = directoryInput ? "" : basename(expanded);
  const prefix = typed === "~"
    ? `~${sep}`
    : directoryInput
      ? typed
      : typed.slice(0, typed.length - base.length);
  return {
    directory: directoryInput ? expanded : dirname(expanded),
    base,
    prefix
  };
}

/** Resolve `~` so the reader opens the path the writer typed. */
export function expandLeadingTilde(value: string): string {
  if (value === "~") return homedir();
  if (/^~[\\/]/u.test(value)) return join(homedir(), value.slice(2));
  return value;
}

function longestCommonPrefix(values: readonly string[]): string {
  const first = [...(values[0] ?? "")];
  let length = first.length;
  for (const value of values.slice(1)) {
    const characters = [...value];
    length = Math.min(length, characters.length);
    let index = 0;
    while (index < length && first[index] === characters[index]) index += 1;
    length = index;
    if (length === 0) break;
  }
  return first.slice(0, length).join("");
}
