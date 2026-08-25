import type { AppSource } from "./app.js";
import type { BackendActionContext } from "./action-context.js";
import { readClipboardContent } from "./clipboard.js";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import { attachDraftImage, draftImagesFor, MAX_DRAFT_IMAGES } from "./draft-image.js";
import { currentImageInputCapability, imageInputRefusalMessage } from "./image-input-runtime.js";
import { imageAttachmentLabel } from "../../shared/image-attachment.js";
import { imageClipboardEntryPointOpen } from "../../shared/image-input-release.js";
import { sanitizePastedText } from "./keys.js";
import type { RetakePromptSession } from "./state.js";

interface ComposeClipboardHost {
  interactionVersion: number;
  mode: string;
  composer: ComposerState;
  retakePrompt: RetakePromptSession | null;
  toast: string | null;
}

/** Read the platform clipboard without applying a result to a changed draft.
 *  Text inserts into the draft exactly as before; an image stages and
 *  attaches as a Draft Image instead, never as marker text, but only once
 *  the clipboard image release gate (shared/image-input-release.ts) is open.
 *  While it is closed, a clipboard image falls back to the behavior it had
 *  before Image Input existed: unreadable, the same as any other content
 *  `readFromClipboard` cannot turn into text.
 *
 *  `imageClipboardOpen` defaults to the release constant. A test can pass an
 *  explicit value to operate the image branch behind the release gate. */
export async function pasteClipboardIntoComposer(
  host: ComposeClipboardHost,
  source: AppSource,
  context: BackendActionContext,
  imageClipboardOpen: boolean = imageClipboardEntryPointOpen()
): Promise<void> {
  const claim = {
    interactionVersion: host.interactionVersion,
    composer: host.composer,
    text: host.composer.text,
    cursor: host.composer.cursor,
    anchor: host.composer.anchor,
    fullscreen: host.composer.fullscreen
  };
  const unchanged = () => host.mode === "COMPOSE"
    && host.interactionVersion === claim.interactionVersion
    && host.composer === claim.composer
    && host.composer.text === claim.text
    && host.composer.cursor === claim.cursor
    && host.composer.anchor === claim.anchor
    && host.composer.fullscreen === claim.fullscreen;
  const content = await readClipboardContent(imageClipboardOpen);
  if (!unchanged()) return;
  if (content === null) {
    host.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return;
  }
  if (content.type === "image") {
    if (!imageClipboardOpen) {
      // Same message and same outcome `readFromClipboard` gave for an image
      // before Image Input existed: unreadable, never an error.
      host.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
      return;
    }
    await attachClipboardImage(host, source, context, claim.composer, content, unchanged);
    return;
  }
  const clean = sanitizePastedText(content.text);
  if (clean.length === 0) {
    host.toast = "clipboard has no insertable text";
    return;
  }
  insertComposerText(host.composer, clean);
}

async function attachClipboardImage(
  host: ComposeClipboardHost,
  source: AppSource,
  context: BackendActionContext,
  composer: ComposerState,
  content: { mediaType: Parameters<AppSource["api"]["stageStoryImage"]>[1]; bytes: Uint8Array },
  unchanged: () => boolean
): Promise<void> {
  if (host.retakePrompt?.intent.kind === "rewrite") {
    host.toast = "an image cannot be attached to a rewrite";
    return;
  }
  if (draftImagesFor(composer).length >= MAX_DRAFT_IMAGES) {
    host.toast = `already ${MAX_DRAFT_IMAGES} images attached · remove one first`;
    return;
  }
  const resolution = currentImageInputCapability(source.settingsView);
  if (resolution.support !== "supported") {
    host.toast = imageInputRefusalMessage(resolution);
    return;
  }
  await context.backend.run("attaching image", async (task) => {
    try {
      const staged = await source.api.stageStoryImage(task.storyId, content.mediaType, content.bytes);
      if (!task.storyCurrent() || !unchanged() || host.composer !== composer) return;
      const images = attachDraftImage(composer, { leaseId: staged.leaseId, attachment: staged.attachment });
      host.toast = `attached ${imageAttachmentLabel(images.length - 1)}`;
    } catch (error) {
      if (!task.interactionCurrent() || !unchanged()) return;
      host.toast = error instanceof Error ? error.message : String(error);
    }
  });
}
