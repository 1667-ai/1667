import type { DraftHandle } from "../generation/actions.js";
import type { StoryComposeDraft } from "./state.js";

/** What a draft handle may read and write of one story's composer. */
export interface DraftHost {
  read(): StoryComposeDraft;
  write(update: (draft: StoryComposeDraft) => StoryComposeDraft): void;
}

/**
 * The draft of a Direct send. The composer was emptied when the send began.
 * The TUI's rules (`restorePendingGenerationDraft`,
 * `clearPendingGenerationDraft`) decide the rest:
 *
 * - `restore` puts the text back only when the box is empty or already
 *   holds the same text. A newer text wins, and the sent text is in the
 *   history, so nothing is lost. The box is never restored twice.
 * - `clear` empties the box only when it still holds exactly the restored
 *   text, so a text the writer changed since is never wiped.
 */
export function createDirectDraft(host: DraftHost, text: string): DraftHandle {
  return {
    restore: () => {
      const current = host.read().direct;
      if (current.length > 0 && current !== text) return false;
      if (current.length === 0) host.write((draft) => ({ ...draft, direct: text }));
      return true;
    },
    clear: () => {
      const current = host.read();
      // A clear must not wipe text that came from the history.
      if (current.direct !== text || current.walk !== null) return;
      host.write((draft) => ({ ...draft, direct: "" }));
    }
  };
}

/**
 * The draft of a retake send. The retake was closed when the send began, and
 * the Direct text came back into the box. A failed retake goes back into
 * retake mode, but only if the writer has not started another retake and has
 * not changed the Direct text since — otherwise the retake text stays in the
 * history. `clear` closes a restored retake that the writer did not touch.
 */
export function createRetakeDraft(
  host: DraftHost,
  retake: { readonly nodeId: string; readonly text: string },
  directAtSend: string
): DraftHandle {
  return {
    restore: () => {
      const current = host.read();
      if (current.retake !== null || current.direct !== directAtSend) return false;
      host.write((draft) => ({ ...draft, retake: { nodeId: retake.nodeId, text: retake.text } }));
      return true;
    },
    clear: () => {
      const current = host.read().retake;
      if (current === null || current.nodeId !== retake.nodeId || current.text !== retake.text) return;
      host.write((draft) => ({ ...draft, retake: null }));
    }
  };
}
