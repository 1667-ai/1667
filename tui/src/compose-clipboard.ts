import { readFromClipboard } from "./clipboard.js";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import { sanitizePastedText } from "./keys.js";

interface ComposeClipboardHost {
  interactionVersion: number;
  mode: string;
  composer: ComposerState;
  toast: string | null;
}

/** Read the platform clipboard without applying a result to a changed draft. */
export async function pasteClipboardIntoComposer(
  host: ComposeClipboardHost
): Promise<void> {
  const claim = {
    interactionVersion: host.interactionVersion,
    composer: host.composer,
    text: host.composer.text,
    cursor: host.composer.cursor,
    anchor: host.composer.anchor,
    fullscreen: host.composer.fullscreen
  };
  const text = await readFromClipboard();
  if (host.mode !== "COMPOSE"
    || host.interactionVersion !== claim.interactionVersion
    || host.composer !== claim.composer
    || host.composer.text !== claim.text
    || host.composer.cursor !== claim.cursor
    || host.composer.anchor !== claim.anchor
    || host.composer.fullscreen !== claim.fullscreen) {
    return;
  }
  if (text === null) {
    host.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return;
  }
  const clean = sanitizePastedText(text);
  if (clean.length === 0) {
    host.toast = "clipboard has no insertable text";
    return;
  }
  insertComposerText(host.composer, clean);
}
