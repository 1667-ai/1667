/**
 * Draft Images attached to a composer draft but not yet submitted.
 *
 * Kept off `ComposerState` on purpose (`ComposerState` is deliberately a
 * pure text buffer) and off `RuntimeState`/`StoryScreenState` too, because
 * that interface is built by a whole-object literal in `app.ts` (and by
 * several existing test fixtures) that this slice does not own and must not
 * grow a new required field onto.
 *
 * Instead this module keys the live array off the exact `ComposerState`
 * object that owns it, in a `WeakMap`, the same pattern
 * `composer-model.ts` already uses for its own per-composer document and
 * undo-history side tables. Because `composer-ownership.ts` reassigns
 * `state.composer` to swap the Direct editor for a retake's own composer
 * (and back), reading `draftImagesFor(state.composer)` always answers for
 * whichever composer currently owns the screen, with no separate swap code
 * of its own to keep in sync.
 */
import type { StoryImageAttachment } from "../../shared/image-attachment.js";
import { MAX_ACTIVE_PROMPT_IMAGES } from "../../shared/image-attachment.js";
import type { ComposerState } from "./composer-model.js";

export interface DraftImage {
  readonly leaseId: string;
  readonly attachment: StoryImageAttachment;
}

const DRAFT_IMAGES = new WeakMap<ComposerState, readonly DraftImage[]>();

export { MAX_ACTIVE_PROMPT_IMAGES as MAX_DRAFT_IMAGES };

/** The ordered Draft Images attached to one composer. Empty when none are. */
export function draftImagesFor(composer: ComposerState): readonly DraftImage[] {
  return DRAFT_IMAGES.get(composer) ?? [];
}

/** Replace one composer's whole ordered list. An empty list clears the entry
 *  outright, so an untouched composer never holds a stale empty array. */
export function setDraftImages(composer: ComposerState, images: readonly DraftImage[]): void {
  if (images.length === 0) DRAFT_IMAGES.delete(composer);
  else DRAFT_IMAGES.set(composer, images);
}

/** Append one staged image, ordered after whatever is already attached. */
export function attachDraftImage(composer: ComposerState, image: DraftImage): readonly DraftImage[] {
  const next = [...draftImagesFor(composer), image];
  setDraftImages(composer, next);
  return next;
}

/** Drop the image at `index`. Out-of-range is a no-op. */
export function removeDraftImageAt(composer: ComposerState, index: number): readonly DraftImage[] {
  const current = draftImagesFor(composer);
  if (index < 0 || index >= current.length) return current;
  const next = current.filter((_, candidate) => candidate !== index);
  setDraftImages(composer, next);
  return next;
}

/** `418 KiB`, `2.3 MiB` - the composer's draft-image rows and the request
 *  viewer's image blocks both show a byte length this way. */
export function formatImageBytes(byteLength: number): string {
  const kib = byteLength / 1024;
  if (kib < 1_000) return `${Math.max(1, Math.round(kib))} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

/** The ordered `{leaseId, objectId}` pairs a generation request carries.
 *  The shape matches `DraftImageReference` in `shared/image-attachment.ts`,
 *  so `StoryApi.continueStory` accepts this array directly. A Retake's
 *  inherited attachments never appear here: the server derives those from the
 *  current manifest, so the client never names a committed Image Object. */
export function draftImageReferences(
  images: readonly DraftImage[]
): ReadonlyArray<{ readonly leaseId: string; readonly objectId: string }> {
  return images.map((image) => ({ leaseId: image.leaseId, objectId: image.attachment.objectId }));
}
