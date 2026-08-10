/**
 * Resolve a `continueStory` request's Image Attachments before generation
 * begins. Combine Retake-inherited attachments with newly staged Draft
 * Images. Refuse a duplicate Image Object before any object byte is read.
 * Verify a resolved Image Object's bytes against its declared metadata
 * before it can reach a provider.
 *
 * This module is split out of server/generation-http.ts to keep that file's
 * own size in check. This module owns every image-specific step
 * `continueStory` delegates to, so the call site there stays a short,
 * readable sequence.
 */
import { nodeById } from "../shared/story-tree.js";
import type { Story, StoryNode } from "../shared/types.js";
import {
  MAX_ACTIVE_PROMPT_IMAGES,
  type DraftImageReference,
  type StoryImageAttachment
} from "../shared/image-attachment.js";
import {
  estimateImageTokens,
  resolveImageInputCapability,
  type ImageInputCapabilityResolution,
  type ImageInputContext
} from "../shared/image-input-capabilities.js";
import { ServiceError as HttpError } from "./errors.js";
import { parseImageHeader } from "./image-header.js";

/** The narrow slice of `StoryStore` (server/stories.ts) that image
 *  resolution needs. `StoryStore` satisfies this structurally. A test may
 *  supply its own stub instead of a real store. */
export interface ImageAttachmentStore {
  resolveDraftImage(storyId: string, reference: DraftImageReference): Promise<StoryImageAttachment>;
  loadImage(storyId: string, objectId: string): Promise<Buffer>;
}

export interface ResolvedContinueStoryImages {
  /** Ordered, combined (inherited then drafted) Image Attachments for the
   *  take being generated. Empty when the request carries no images and
   *  inherits none. */
  readonly attachments: readonly StoryImageAttachment[];
  /** Draft Lease ids consumed to resolve `attachments`: one entry per
   *  drafted attachment, none for an inherited one. Remove these only after
   *  the manifest and receipt that used them are durable, never before (see
   *  server/story-provider-mutation.ts's `commitTerminal`). */
  readonly leaseIds: readonly string[];
}

/** The current active child of `parentId`: the take a plain Retake would
 *  replace. Its own Image Attachments are what a Retake inherits. The
 *  server derives inherited attachments from the Retake target in the
 *  current manifest (image-input design). Returns null for a fresh root, a
 *  parent with no current take, or a request that names no parent at all.
 *  Every one of those cases has nothing to inherit from. */
function retakeTarget(story: Story, parentId: string | null): StoryNode | null {
  if (parentId === null) return null;
  const parent = nodeById(story, parentId);
  if (parent === null || parent.activeChildId === null) return null;
  return nodeById(story, parent.activeChildId);
}

/**
 * Resolve one `continueStory` request's Image Attachments. Refuses before
 * any Image Object byte is read:
 *
 * - an absent or expired Draft Lease, or one that names a different Image
 *   Object than the reference claims (`image_attachment_expired`, from
 *   `store.resolveDraftImage`);
 * - a duplicate Image Object id across the inherited and drafted lists
 *   (`image_attachment_duplicate`);
 * - more than `MAX_ACTIVE_PROMPT_IMAGES` combined (`image_context_too_large`).
 *
 * Callers must resolve `appendTo` versus `parentId` themselves before
 * calling this function. `server/generation-http.ts`'s `continueStory`
 * downgrades an append that carries a new image into a new-child-take
 * request, the same way it already downgrades one that crosses a chapter
 * break. This matches the design rule: an append request with an image must
 * create a new child take. This function still refuses the append-plus-image
 * combination defensively. An append mutates an existing part, and a stored
 * part records the exact provider input it was generated from, so this is
 * the last-resort guard if a future caller forgets to downgrade.
 * `server/story-nodes.ts`'s `assertNoAppendImageAttachments` enforces the
 * same invariant again at commit.
 */
export async function resolveContinueStoryImages(
  store: ImageAttachmentStore | null,
  storyId: string,
  story: Story,
  parentId: string | null,
  appendTo: string | null,
  images: readonly DraftImageReference[]
): Promise<ResolvedContinueStoryImages> {
  if (appendTo !== null) {
    if (images.length > 0) {
      throw new HttpError(
        500,
        "An append request must not carry an image; the caller must downgrade to a new child take.",
        "image_attachment_duplicate"
      );
    }
    return { attachments: [], leaseIds: [] };
  }
  const inherited = retakeTarget(story, parentId)?.imageAttachments ?? [];
  const drafted: StoryImageAttachment[] = [];
  const leaseIds: string[] = [];
  if (images.length > 0) {
    if (store === null) {
      // Fail closed: a caller with a Draft Image to resolve but no reader to
      // resolve it with is a programming error, not a request the writer
      // could cause. Every production call site supplies a store.
      throw new HttpError(500, "Image resolution is not available for this request.", "image_input_not_supported");
    }
    // Sequential, not parallel. Each resolution already claims its own story
    // `ioQueue` turn, and the ordered list a client submits is exactly the
    // order the take should carry. A stable, simple loop preserves that
    // order without adding a sort step.
    for (const reference of images) {
      drafted.push(await store.resolveDraftImage(storyId, reference));
      leaseIds.push(reference.leaseId);
    }
  }
  const attachments = [...inherited, ...drafted];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (seen.has(attachment.objectId)) {
      throw new HttpError(
        400,
        "This image is already attached to this take.",
        "image_attachment_duplicate"
      );
    }
    seen.add(attachment.objectId);
  }
  if (attachments.length > MAX_ACTIVE_PROMPT_IMAGES) {
    throw new HttpError(
      400,
      `A take may carry at most ${MAX_ACTIVE_PROMPT_IMAGES} images.`,
      "image_context_too_large"
    );
  }
  return { attachments, leaseIds };
}

/**
 * Load one Image Object's bytes for provider dispatch, and verify them
 * against the attachment's own recorded metadata before returning. Callers
 * must load bytes only after every local admission check already passed,
 * never earlier, so a refused request never reads a byte it will not send.
 * A byte length, media type, or dimension mismatch against the stored bytes
 * means the object no longer matches what the story recorded about it.
 * Refuse with `image_invalid` rather than send a provider a payload that
 * disagrees with its own declared shape.
 */
export async function loadVerifiedImageBytes(
  store: ImageAttachmentStore,
  storyId: string,
  attachment: StoryImageAttachment
): Promise<Buffer> {
  const bytes = await store.loadImage(storyId, attachment.objectId);
  if (bytes.byteLength !== attachment.byteLength) {
    throw new HttpError(500, "The stored image no longer matches its recorded size.", "image_invalid");
  }
  let header;
  try {
    header = parseImageHeader(bytes, attachment.mediaType);
  } catch (error) {
    throw new HttpError(500, "The stored image is damaged.", "image_invalid", { cause: error });
  }
  if (header.mediaType !== attachment.mediaType
    || header.width !== attachment.width
    || header.height !== attachment.height) {
    throw new HttpError(500, "The stored image no longer matches its recorded metadata.", "image_invalid");
  }
  return bytes;
}

/** Load and verify every distinct Image Object the active prompt
 *  references, keyed by object id: the shape `server/providers.ts`'s
 *  `StreamCompletionOptions.imageBytes` takes. The same Image Object can
 *  occur on more than one active story part. This loads it once regardless
 *  of how many attachments name it. A caller with images to load and no
 *  store is a programming error, refused the same way
 *  `resolveContinueStoryImages` refuses one. */
export async function loadActiveImageBytes(
  store: ImageAttachmentStore | null,
  storyId: string,
  activeImages: readonly StoryImageAttachment[]
): Promise<ReadonlyMap<string, Uint8Array>> {
  const byId = new Map<string, StoryImageAttachment>();
  for (const attachment of activeImages) byId.set(attachment.objectId, attachment);
  if (byId.size === 0) return new Map();
  if (store === null) {
    // Fail closed: a caller with an Image Object to load and no reader to
    // load it with is a programming error, refused the same way
    // `resolveContinueStoryImages` refuses one.
    throw new HttpError(500, "Image resolution is not available for this request.", "image_input_not_supported");
  }
  const entries = await Promise.all(
    [...byId.values()].map(async (attachment): Promise<readonly [string, Uint8Array]> =>
      [attachment.objectId, await loadVerifiedImageBytes(store, storyId, attachment)])
  );
  return new Map(entries);
}

export interface ActiveImageContext {
  /** Every image the active prompt will carry: already-committed context
   *  parts' own attachments, in prompt order, plus this take's own newly
   *  resolved ones. */
  readonly activeImages: readonly StoryImageAttachment[];
  /** Undefined for a text-only request. `server/generation-admission.ts`'s
   *  `assertImageContextAdmitted` treats an undefined capability as fail
   *  closed, so this stays undefined exactly when there is nothing to
   *  authorize. */
  readonly capability?: ImageInputCapabilityResolution;
  /** Visual tokens for the whole active prompt, summed with the
   *  capability's own strategy. 0 when the capability has no strategy to
   *  estimate with (`unknown` or `unsupported`); a later admission check
   *  refuses that case once the prompt exists, so this value is never
   *  load-bearing for it. */
  readonly fixedImageTokens: number;
}

/** Assemble the image half of prompt admission for one `continueStory`
 *  request: every active image, whether the model's resolved capability
 *  authorizes any of them, and the visual-token total to reserve. A
 *  text-only request (no context part carries an attachment and the take
 *  resolved none) never calls `resolveImageInputCapability`, so its
 *  behavior and request bytes stay exactly as they were before Image Input
 *  existed. */
export function activeImageContext(
  contextParts: readonly StoryNode[],
  resolvedAttachments: readonly StoryImageAttachment[],
  imageContext: ImageInputContext
): ActiveImageContext {
  const activeImages: readonly StoryImageAttachment[] = [
    ...contextParts.flatMap((part) => part.imageAttachments ?? []),
    ...resolvedAttachments
  ];
  if (activeImages.length === 0) return { activeImages, fixedImageTokens: 0 };
  const capability = resolveImageInputCapability(imageContext);
  const fixedImageTokens = capability.support === "supported"
    ? activeImages.reduce((sum, image) => sum + estimateImageTokens(capability.strategy, image.width, image.height), 0)
    : 0;
  return { activeImages, capability, fixedImageTokens };
}
