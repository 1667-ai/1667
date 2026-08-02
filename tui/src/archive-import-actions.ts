import { countNoun, fidelityReport } from "../../shared/fidelity.js";
import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { completeFilePath, errorMessage, expandLeadingTilde } from "./path-completion.js";
import { readImportBytes } from "../../server/import-file.js";
import type { ResolvedKey } from "./keys.js";
import { recordNotice } from "./notice-log.js";
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
    await completeFilePath(overlay);
  } else if (resolved.action === "apply") {
    await applyArchiveImport(overlay, state, source, context);
  }
  return true;
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
    overlay.error = "type the path to a .lorebook, .json, .scenario, or .story file";
    return;
  }

  const route = archiveRoute(overlay.path);
  if (route === null) {
    overlay.error = "unsupported archive · use .lorebook, .json, .scenario, or .story";
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

      if (route === "facts") {
        const { payload, importResult } = await source.api.importLorebook(task.storyId, bytes);
        if (!task.storyCurrent()) return;
        adoptSameStoryPayload(state, payload);
        context.cache.invalidate();
        adopted = true;
        const keyed = importResult.facts.filter((fact) => fact.activation === "keyed").length;
        const always = importResult.facts.length - keyed;
        // `!` opens the log in NAV and MAP only. An import started from the
        // composer returns there, where `!` would type into the draft. How many
        // times esc is needed depends on whether the composer was fullscreen,
        // so name the place the report is rather than a keystroke that may be
        // wrong.
        const report = overlay.returnMode === "COMPOSE"
          ? "full report in the log"
          : "! full report";
        state.toast = `${importResult.facts.length} ${countNoun(importResult.facts.length, "Fact")} imported`
          + ` · ${keyed} keyed · ${always} always · ${report}`;
        // The toast holds four rows and the report does not. Write the whole
        // account to the log, or a writer importing in the app never learns
        // what the archive lost.
        recordNotice(state.notices, "toast", `${importResult.facts.length} facts imported · `
          + fidelityReport(importResult.fidelity));
        return;
      }

      const text = new TextDecoder("utf-8").decode(bytes);
      const { payload } = route === "scenario"
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

function archiveRoute(value: string): "facts" | "scenario" | "story" | null {
  const lower = value.toLowerCase();
  if (lower.endsWith(".lorebook")) return "facts";
  if (lower.endsWith(".scenario")) return "scenario";
  if (lower.endsWith(".story")) return "story";
  // SillyTavern writes World Info as plain .json. A character card is .json
  // too, so the reader tells them apart by shape and says which door to use.
  if (lower.endsWith(".json")) return "facts";
  return null;
}

