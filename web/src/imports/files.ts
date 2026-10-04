import { MAX_IMPORT_BYTES } from "../../../shared/types.js";

/** The four story files; each one makes a new story. */
export type StoryFileKind = "markdown" | "sillytavern" | "novelai" | "scenario";

export const STORY_FILE_ACCEPT = ".md,.jsonl,.story,.scenario";
export const ARCHIVE_ACCEPT = ".lorebook,.json,.png,.scenario,.story";
export const CARD_ACCEPT = ".json,.png";

/** What the TUI says for an archive it cannot read (`archive-import-actions.ts`),
 * with `.png` added: the web also reads a NovelAI lorebook inside a PNG. */
export const UNSUPPORTED_ARCHIVE = "unsupported archive · use .lorebook, .json, .png, .scenario, or .story";
export const UNSUPPORTED_STORY_FILE = "unsupported file · use .md, .jsonl, .story, or .scenario";

export function storyFileKind(name: string): StoryFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".jsonl")) return "sillytavern";
  if (lower.endsWith(".story")) return "novelai";
  if (lower.endsWith(".scenario")) return "scenario";
  return null;
}

/** As the TUI's `archiveRoute`: what an archive file turns into. A World Info
 * file is `.json` too; a character card is told apart by the backend. */
export function archiveRoute(name: string): "facts" | "scenario" | "story" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".scenario")) return "scenario";
  if (lower.endsWith(".story")) return "story";
  if (lower.endsWith(".lorebook") || lower.endsWith(".json") || lower.endsWith(".png")) return "facts";
  return null;
}

/** The refusal for a file above the import limit (the TUI's wording), or `null`. */
export function tooLargeMessage(size: number): string | null {
  if (size <= MAX_IMPORT_BYTES) return null;
  return `file is ${Math.round(size / 1e6)}MB — larger than the ${MAX_IMPORT_BYTES / 1e6}MB import limit`;
}

/** The file's name without its last extension: a Markdown story's default title. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Opens the browser's file chooser. The chooser needs the keyboard or mouse
 * action that is running, so this is called straight from a click or a command. */
export function pickFiles(options: { readonly accept: string; readonly multiple: boolean }, onPicked: (files: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = options.accept;
  input.multiple = options.multiple;
  input.hidden = true;
  const done = (): void => input.remove();
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    done();
    if (files.length > 0) onPicked(files);
  });
  input.addEventListener("cancel", done);
  document.body.append(input);
  input.click();
}
