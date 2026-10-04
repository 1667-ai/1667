import { countWords } from "../../../shared/story-text.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { manuscriptModelOf } from "./manuscript-model.js";

/** What `y` (a part), `Y` (the whole line) and the part menu's Copy say, as the TUI's `copyStoryText` does. */
export type CopyTarget =
  | { readonly kind: "part"; readonly partId: string }
  | { readonly kind: "line" }
  | { readonly kind: "selection"; readonly text: string };

export const NOTHING_TO_COPY_TOAST = "Nothing to copy here.";
export const NO_CLIPBOARD_TOAST = "No clipboard available. Select the text and copy it by hand.";

/** The text a copy puts on the clipboard, and how the toast names it. */
function copyContent(payload: StoryPayload, target: CopyTarget): { text: string; what: string } {
  if (target.kind === "selection") return { text: target.text, what: "selection" };
  if (target.kind === "line") {
    return { text: payload.path.map((node) => node.text).join("\n\n"), what: `line · ${payload.path.length} parts` };
  }
  const part = manuscriptModelOf(payload).parts.find((candidate) => candidate.id === target.partId);
  return { text: part?.node.text ?? "", what: `¶ ${part?.number ?? 0}` };
}

export async function copyStoryText(store: Store<AppState>, payload: StoryPayload, target: CopyTarget): Promise<void> {
  const { text, what } = copyContent(payload, target);
  if (text.length === 0) {
    pushToast(store, NOTHING_TO_COPY_TOAST);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    pushToast(store, NO_CLIPBOARD_TOAST);
    return;
  }
  pushToast(store, `Copied ${what} · ${countWords(text).toLocaleString("en-US")} words`);
}
