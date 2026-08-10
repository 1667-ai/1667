/**
 * The `attach image` command: a `FilePathPrompt`-shaped modal, the reliable
 * path over SSH and `--url`. Mirrors `card-import-actions.ts` closely, same
 * shape, same bounded read, same backend-task guard, with an image-specific
 * header check and staging call in place of the card import.
 */
import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { completeFilePath, errorMessage, expandLeadingTilde } from "./path-completion.js";
import { parseImageHeader } from "../../server/image-header.js";
import { MAX_SOURCE_IMAGE_BYTES, imageAttachmentLabel } from "../../shared/image-attachment.js";
import { readImportBytes } from "../../server/import-file.js";
import { attachDraftImage, draftImagesFor, MAX_DRAFT_IMAGES } from "./draft-image.js";
import { currentImageInputCapability, imageInputRefusalMessage } from "./image-input-runtime.js";
import type { ResolvedKey } from "./keys.js";
import type { ImageAttachPrompt, RuntimeState } from "./state.js";

/** Refuse before opening the panel: capability, the four-image ceiling, and
 *  the rewrite-composer carve-out (image attachment targets a fresh passage,
 *  never a highlighted excerpt). */
export function openImageAttach(
  state: RuntimeState,
  source: AppSource,
  returnMode: ImageAttachPrompt["returnMode"] = state.mode === "COMPOSE" ? "COMPOSE" : "NAV"
): void {
  if (state.retakePrompt?.intent.kind === "rewrite") {
    state.toast = "an image cannot be attached to a rewrite";
    return;
  }
  if (draftImagesFor(state.composer).length >= MAX_DRAFT_IMAGES) {
    state.toast = `already ${MAX_DRAFT_IMAGES} images attached · remove one first`;
    return;
  }
  const resolution = currentImageInputCapability(source.settingsView);
  if (resolution.support !== "supported") {
    state.toast = imageInputRefusalMessage(resolution);
    return;
  }
  state.image = {
    path: "",
    storyId: state.payload.id,
    candidates: [],
    error: null,
    returnMode
  };
  state.mode = "IMAGE";
}

export async function imageAttachAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const overlay = state.image!;
  if (resolved.action === "cancel") {
    state.image = null;
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
    await applyImageAttach(overlay, state, source, context);
  }
  return true;
}

async function applyImageAttach(
  overlay: ImageAttachPrompt,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<void> {
  if (state.connection.down) {
    overlay.error = "offline · cannot attach an image now";
    return;
  }
  if (overlay.path.trim().length === 0) {
    overlay.error = "type the path to an image file";
    return;
  }

  let bytes: Uint8Array;
  try {
    // Bound bytes before any decode, and before this ever becomes a second
    // Uint8Array beyond the one readImportBytes itself allocates: a regular
    // path only, opened O_NONBLOCK, rejecting a directory, a FIFO, or a
    // device before any content read.
    bytes = await readImportBytes(expandLeadingTilde(overlay.path), {
      maximumBytes: MAX_SOURCE_IMAGE_BYTES,
      tooLargeMessage: `image is larger than the ${Math.round(MAX_SOURCE_IMAGE_BYTES / 1_000_000)}MB limit`
    });
  } catch (error) {
    overlay.error = errorMessage(error);
    return;
  }

  let mediaType: Awaited<ReturnType<typeof parseImageHeader>>["mediaType"];
  try {
    // The same bounded header parser the server runs: magic bytes, declared
    // dimensions, and pixel count, all read before any raster is allocated.
    // Running it here too means a file the server would refuse never makes
    // the round trip.
    ({ mediaType } = parseImageHeader(bytes));
  } catch (error) {
    overlay.error = errorMessage(error);
    return;
  }

  const composer = state.composer;
  if (draftImagesFor(composer).length >= MAX_DRAFT_IMAGES) {
    overlay.error = `already ${MAX_DRAFT_IMAGES} images attached · remove one first`;
    return;
  }

  try {
    const ran = await context.backend.run("attaching image", async (task) => {
      // The read above awaited, and run() reads the current story only now. A
      // swap in between must not attach this image to a story nobody chose.
      if (task.storyId !== overlay.storyId) {
        overlay.error = "the open story changed · start the attachment again";
        return;
      }
      const staged = await source.api.stageStoryImage(task.storyId, mediaType, bytes);
      if (!task.storyCurrent() || state.composer !== composer) return;
      const images = attachDraftImage(composer, { leaseId: staged.leaseId, attachment: staged.attachment });
      if (state.image === overlay) {
        state.image = null;
        state.mode = overlay.returnMode;
        state.toast = `attached ${imageAttachmentLabel(images.length - 1)}`;
      }
    });
    if (!ran && overlay.error === null) {
      // The runtime refuses a second backend task and says so in a toast that
      // the next key clears. The open panel has to keep the reason.
      overlay.error = "another task is running · start the attachment again";
    }
  } catch (error) {
    overlay.error = errorMessage(error);
  }
}
