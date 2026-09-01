import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { completeFilePath, errorMessage, expandLeadingTilde } from "./path-completion.js";
import { describeCardImport } from "./card-import.js";
import type { CardImportPlan } from "../../shared/card-import.js";
import { readImportBytes } from "../../server/import-file.js";
import type { ResolvedKey } from "./keys.js";
import { recordNotice } from "./notice-log.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import { settleModeUnderPalette } from "./palette-owner.js";
import type { CardImportPrompt, RuntimeState } from "./state.js";
import { fidelityReport } from "../../shared/fidelity.js";

export function openCardImport(
  state: RuntimeState,
  returnMode: CardImportPrompt["returnMode"] = state.mode === "COMPOSE" ? "COMPOSE" : "NAV"
): void {
  state.card = {
    path: "",
    storyId: state.payload.id,
    candidates: [],
    error: null,
    returnMode
  };
  state.mode = "CARD";
}

export async function cardImportAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.card!;
  if (resolved.action === "cancel") {
    state.card = null;
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
    await applyCardImport(overlay, state, source, context);
  }
  return true;
}

async function applyCardImport(
  overlay: CardImportPrompt,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (state.connection.down) {
    // Every other failure here stays in the hint slot. A toast would clear on
    // the next key and leave the open panel with nothing to explain itself.
    overlay.error = "offline · cannot import a card now";
    return;
  }
  if (overlay.path.trim().length === 0) {
    overlay.error = "type the path to a character card file";
    return;
  }

  let bytes: Uint8Array;
  try {
    // The field keeps the `~` the writer typed, so the read has to expand it.
    bytes = await readImportBytes(expandLeadingTilde(overlay.path));
  } catch (error) {
    overlay.error = errorMessage(error);
    return;
  }

  let plan: CardImportPlan | null = null;
  let adopted = false;
  try {
    const ran = await context.backend.run("importing character card", async (task) => {
      // The read above awaited, and run() reads the current story only now. A
      // swap in between must not send this card to a story nobody chose.
      if (task.storyId !== overlay.storyId) {
        overlay.error = "the open story changed · start the import again";
        return;
      }
      // The service loads the story and computes the room itself, the same
      // seam `importLorebook` already uses, so there is no client-side room
      // estimate here to go stale.
      const result = await source.api.importCard(task.storyId, bytes);
      if (!task.storyCurrent()) return;
      plan = result.plan;
      adoptSameStoryPayload(state, result.payload, context.cache);
      adopted = true;
    });
    // TypeScript's flow analysis does not see the assignment inside the
    // closure above, so it narrows `plan` from its initializer alone; the
    // cast restores the type this variable can actually hold once the
    // closure has run.
    const finishedPlan = plan as CardImportPlan | null;
    if (ran && adopted && finishedPlan !== null && state.card === overlay) {
      settleModeUnderPalette(state, "CARD", overlay.returnMode);
      state.card = null;
      const headline = `imported ${describeCardImport(finishedPlan)}`;
      if (finishedPlan.fidelity.length === 0) {
        state.toast = headline;
      } else {
        // The toast holds four rows and the report does not. Write the whole
        // account to the log, or a writer importing a V3 card in the app
        // never learns what it lost — the same trade the archive import
        // panel makes.
        const report = overlay.returnMode === "COMPOSE" ? "full report in the log" : "! full report";
        state.toast = `${headline} · ${report}`;
        recordNotice(state.notices, "toast", `${headline} · ${fidelityReport(finishedPlan.fidelity)}`);
      }
    } else if (!ran && overlay.error === null) {
      // The runtime refuses a second backend task and says so in a toast that
      // the next key clears. The open panel has to keep the reason.
      overlay.error = "another task is running · start the import again";
    }
  } catch (error) {
    overlay.error = errorMessage(error);
  }
}
