import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { countNoun } from "../../shared/fidelity.js";
import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { readImportBytes } from "./import-file.js";
import type { ResolvedKey } from "./keys.js";
import { publishStories } from "./overlay-publication.js";
import { adoptSameStoryPayload, adoptStoryState } from "./story-adoption.js";
import type { ArchiveImportPrompt, RuntimeState } from "./state.js";

export function openArchiveImport(
  state: RuntimeState,
  returnMode: ArchiveImportPrompt["returnMode"] = state.mode === "COMPOSE" ? "COMPOSE" : "NAV"
): void {
  state.archive = {
    path: "",
    storyId: state.payload.id,
    candidates: [],
    error: null,
    returnMode
  };
  state.mode = "ARCHIVE";
}

export async function archiveImportAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.archive!;
  if (resolved.action === "cancel") {
    state.archive = null;
    state.mode = overlay.returnMode;
  } else if (resolved.action === "input" || resolved.action === "backspace") {
    overlay.path = resolved.action === "input"
      ? overlay.path + (resolved.text ?? "")
      : [...overlay.path].slice(0, -1).join("");
    overlay.candidates = [];
    overlay.error = null;
  } else if (resolved.action === "complete") {
    await completeArchiveImport(overlay);
  } else if (resolved.action === "apply") {
    await applyArchiveImport(overlay, state, source, context);
  }
  return true;
}

async function completeArchiveImport(overlay: ArchiveImportPrompt): Promise<void> {
  const target = completionTarget(overlay.path);
  overlay.candidates = [];
  overlay.error = null;
  try {
    const entries = await readdir(target.directory, { withFileTypes: true });
    const wanted = target.base.toLowerCase();
    const matches = entries
      .filter((entry) => entry.name.toLowerCase().startsWith(wanted))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (matches.length === 0) {
      overlay.error = "no file matches that path";
      return;
    }
    const names = matches.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    const shared = longestCommonPrefix(names);
    overlay.path = target.prefix
      + ([...shared].length > [...target.base].length ? shared : target.base);
    if (matches.length > 1) overlay.candidates = names;
  } catch (error) {
    overlay.error = errorMessage(error);
  }
}

async function applyArchiveImport(
  overlay: ArchiveImportPrompt,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (state.connection.down) {
    overlay.error = "offline · cannot import an archive now";
    return;
  }
  if (overlay.path.trim().length === 0) {
    overlay.error = "type the path to a .lorebook, .scenario, or .story file";
    return;
  }

  const extension = archiveExtension(overlay.path);
  if (extension === null) {
    overlay.error = "unsupported archive extension · use .lorebook, .scenario, or .story";
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readImportBytes(expandLeadingTilde(overlay.path));
  } catch (error) {
    overlay.error = errorMessage(error);
    return;
  }

  let adopted = false;
  try {
    const ran = await context.backend.run("importing archive", async (task) => {
      if (task.storyId !== overlay.storyId) {
        overlay.error = "the open story changed · start the import again";
        return;
      }

      if (extension === ".lorebook") {
        const { payload, importResult } = await source.api.importLorebook(task.storyId, bytes);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload);
        context.cache.invalidate();
        adopted = true;
        const keyed = importResult.facts.filter((fact) => fact.activation === "keyed").length;
        const always = importResult.facts.length - keyed;
        state.toast = `${importResult.facts.length} ${countNoun(importResult.facts.length, "Fact")} imported`
          + ` · ${keyed} keyed · ${always} always`;
        return;
      }

      const text = new TextDecoder("utf-8").decode(bytes);
      const { payload } = extension === ".scenario"
        ? await source.api.importScenario(text)
        : await source.api.importNovelAI(text);
      if (!task.storyCurrent()) return;
      adoptStoryState(state, payload);
      context.cache.invalidate();
      adopted = true;
      state.toast = `new story · ${payload.nodes.length} ${countNoun(payload.nodes.length, "part")}`
        + ` · ${payload.facts.length} ${countNoun(payload.facts.length, "fact")}`;

      try {
        const stories = await source.api.listStories();
        if (task.owns()) publishStories(state, source, stories);
      } catch { /* The connection surface reports catalog refresh failures. */ }
    });
    if (ran && adopted) {
      if (state.archive === overlay) {
        state.archive = null;
        state.mode = overlay.returnMode;
      }
    } else if (!ran && overlay.error === null) {
      overlay.error = "another task is running · start the import again";
    }
  } catch (error) {
    if (state.archive === overlay) overlay.error = errorMessage(error);
  }
}

function archiveExtension(value: string): ".lorebook" | ".scenario" | ".story" | null {
  const lower = value.toLowerCase();
  if (lower.endsWith(".lorebook")) return ".lorebook";
  if (lower.endsWith(".scenario")) return ".scenario";
  if (lower.endsWith(".story")) return ".story";
  return null;
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

function expandLeadingTilde(value: string): string {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
