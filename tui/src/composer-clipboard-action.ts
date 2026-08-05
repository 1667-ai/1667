import { copyToClipboard } from "./clipboard.js";
import {
  composerSelection,
  selectedComposerText,
  type ComposerState
} from "./composer-model.js";

export interface ComposerClipboardHost {
  interactionVersion: number;
  toast: string | null;
}

export interface ComposerClipboardOptions {
  readonly isCurrent: () => boolean;
  readonly deleteSelection: () => void;
}

/** Copy or cut one composer selection without applying an asynchronous result
 * to a changed editor. A destructive OSC 52 cut needs the same second press on
 * every composer-backed surface because the terminal cannot confirm the host
 * clipboard write. */
export async function composerClipboardAction(
  host: ComposerClipboardHost,
  composer: ComposerState,
  cut: boolean,
  options: ComposerClipboardOptions
): Promise<void> {
  const selection = composerSelection(composer);
  const selectedText = selectedComposerText(composer);
  if (selection === null || selectedText === null) {
    composer.cutConfirmation = null;
    host.toast = "nothing selected";
    return;
  }
  if (!cut) composer.cutConfirmation = null;
  const claim = {
    interactionVersion: host.interactionVersion,
    text: composer.text,
    cursor: composer.cursor,
    anchor: composer.anchor
  };
  const outcome = await copyToClipboard(selectedText);
  if (!options.isCurrent()
    || host.interactionVersion !== claim.interactionVersion
    || composer.text !== claim.text
    || composer.cursor !== claim.cursor
    || composer.anchor !== claim.anchor) {
    return;
  }
  if (outcome === "unavailable") {
    composer.cutConfirmation = null;
    host.toast = "no clipboard available · selection kept";
    return;
  }
  if (cut && outcome !== "command") {
    const confirmation = composer.cutConfirmation;
    if (confirmation?.start !== selection.start
      || confirmation.end !== selection.end
      || confirmation.text !== selectedText) {
      composer.cutConfirmation = { ...selection, text: selectedText };
      host.toast = "clipboard write unconfirmed · cut again to confirm";
      return;
    }
  }
  if (cut) options.deleteSelection();
  composer.cutConfirmation = null;
  host.toast = cut ? "selection cut" : "selection copied";
}
