import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { completeFilePath, errorMessage, expandLeadingTilde } from "./path-completion.js";
import { describeCardImport, planCardImport, type CardImportPlan } from "./card-import.js";
import { readImportBytes } from "../../server/import-file.js";
import type { ResolvedKey } from "./keys.js";
import { adoptSameStoryPayload } from "./story-adoption.js";
import type { CardImportPrompt, RuntimeState } from "./state.js";

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

  let plan: CardImportPlan;
  try {
    // The field keeps the `~` the writer typed, so the read has to expand it.
    plan = planCardImport(await readImportBytes(expandLeadingTilde(overlay.path)));
  } catch (error) {
    overlay.error = errorMessage(error);
    return;
  }

  const facts = [...plan.facts];
  let adopted = false;
  try {
    const ran = await context.backend.run("importing character card", async (task) => {
      // The read above awaited, and run() reads the current story only now. A
      // swap in between must not send this card to a story nobody chose.
      if (task.storyId !== overlay.storyId) {
        overlay.error = "the open story changed · start the import again";
        return;
      }
      const payload = await source.api.createFact(task.storyId, { facts });
      if (!task.storyCurrent()) return;
      adoptSameStoryPayload(state, payload);
      context.cache.invalidate();
      adopted = true;
    });
    if (ran && adopted && state.card === overlay) {
      state.card = null;
      state.mode = overlay.returnMode;
      state.toast = `imported ${describeCardImport(plan)}`;
    } else if (!ran && overlay.error === null) {
      // The runtime refuses a second backend task and says so in a toast that
      // the next key clears. The open panel has to keep the reason.
      overlay.error = "another task is running · start the import again";
    }
  } catch (error) {
    overlay.error = errorMessage(error);
  }
}

