/**
 * The Image Input contract: what 1667 stores for one image, and every bound
 * that keeps an image bounded from the clipboard to the provider body.
 *
 * 1667 never stores the bytes the writer supplies. It normalizes them first
 * (`server/image-normalize.ts`), stores the result once as a content-addressed
 * object beside the take (`server/story-objects.ts`), and puts an ordered list
 * of this metadata on the story part the model generated from it. The metadata
 * is deliberately small and closed: an object id, a media type, two
 * dimensions, and a byte length. It holds no file name and no source path,
 * because a story bundle must not record where its author keeps files.
 *
 * The shape is frozen now because a stored attachment names an object whose
 * bytes are hashed for its content address. A later change to the metadata
 * would have to reach every story that ever stored one.
 */

/** What a stored Normalized Image can be. The normalizer re-encodes every
 *  Source Image to one of these two, so animation data and metadata cannot
 *  survive into the story bundle. */
export const STORED_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;
export type StoredImageMediaType = typeof STORED_IMAGE_MEDIA_TYPES[number];

/** What a writer may hand 1667. WebP is accepted as input and re-encoded; it
 *  is never stored, because a second stored container would give one image two
 *  provider-visible identities for no gain. */
export const SOURCE_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp"
] as const;
export type SourceImageMediaType = typeof SOURCE_IMAGE_MEDIA_TYPES[number];

const STORED_MEDIA_TYPES: ReadonlySet<string> = new Set(STORED_IMAGE_MEDIA_TYPES);
const SOURCE_MEDIA_TYPES: ReadonlySet<string> = new Set(SOURCE_IMAGE_MEDIA_TYPES);

export function isStoredImageMediaType(value: unknown): value is StoredImageMediaType {
  return typeof value === "string" && STORED_MEDIA_TYPES.has(value);
}

export function isSourceImageMediaType(value: unknown): value is SourceImageMediaType {
  return typeof value === "string" && SOURCE_MEDIA_TYPES.has(value);
}

/** Source Image bounds, checked against the header before any decoder
 *  allocates a raster. A file that declares more pixels than this is refused
 *  while it is still bytes. */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_DIMENSION = 8_192;
export const MAX_SOURCE_IMAGE_PIXELS = 32_000_000;

/** Normalized Image bounds. The dimension bound decides what the normalizer
 *  aims for; the base64 bound decides what it must reach before it stores
 *  anything. */
export const MAX_NORMALIZED_IMAGE_DIMENSION = 2_000;
export const MAX_NORMALIZED_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;

/** Active-prompt bounds. One request may carry four images, and their
 *  combined encoded size has its own ceiling, because four images that each
 *  pass the per-image bound can still make a body no provider accepts. */
export const MAX_ACTIVE_PROMPT_IMAGES = 4;
export const MAX_ACTIVE_PROMPT_IMAGE_BASE64_LENGTH = 20 * 1024 * 1024;
export const MAX_IMAGE_PROVIDER_BODY_BYTES = 24 * 1024 * 1024;

/** A Draft Lease keeps one staged image alive until a generation consumes it
 *  or the sweep reclaims it. */
export const DRAFT_IMAGE_LEASE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const IMAGE_STAGE_DEADLINE_MS = 60_000;

/** Draft Image quotas. The story allowance includes four leases for responses
 *  the client never received. */
export const MAX_STORY_DRAFT_IMAGE_LEASES = 8;
export const MAX_STORY_DRAFT_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_PROJECT_DRAFT_IMAGE_LEASES = 64;
export const MAX_PROJECT_DRAFT_IMAGE_BYTES = 256 * 1024 * 1024;

/** The image permit admits one stage and parks two more. A fourth caller is
 *  refused before its body is read. */
export const IMAGE_STAGE_WAITER_LIMIT = 2;

/** The largest object the store will ever hold for an image. A Normalized
 *  Image is bounded by its base64 length, so the raw bytes are three quarters
 *  of that, rounded up to whole base64 groups. */
export const MAX_IMAGE_OBJECT_BYTES = 3 * Math.floor(MAX_NORMALIZED_IMAGE_BASE64_LENGTH / 4);

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** A Draft Lease ID is 256 random bits written as exactly 64 lowercase
 *  hexadecimal characters. The grammar is checked before every filesystem
 *  operation that uses one, so a lease id can never walk out of its
 *  directory. */
const DRAFT_LEASE_ID_PATTERN = /^[a-f0-9]{64}$/u;

export function isDraftImageLeaseId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_LEASE_ID_PATTERN.test(value);
}

export class ImageAttachmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageAttachmentError";
  }
}

/** One ordered reference from a story part to a stored Normalized Image. */
export interface StoryImageAttachment {
  readonly objectId: string;
  readonly mediaType: StoredImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

/** One ordered reference the client submits with a generation request. The
 *  client sends both halves: the lease proves the draft is still live, and the
 *  object id lets the server refuse a duplicate before it reads any object. */
export interface DraftImageReference {
  readonly leaseId: string;
  readonly objectId: string;
}

/** The base64 length of a byte count, which is what a provider body actually
 *  carries. Kept here so admission and the request viewer agree without either
 *  encoding anything. */
export function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function requireDimension(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ImageAttachmentError(`${label} must be a positive integer`);
  }
  if ((value as number) > MAX_NORMALIZED_IMAGE_DIMENSION) {
    throw new ImageAttachmentError(
      `${label} exceeds ${MAX_NORMALIZED_IMAGE_DIMENSION} pixels`
    );
  }
  return value as number;
}

/** Build an attachment from already-decoded parts, enforcing every bound.
 *  Every producer goes through here, so a bound can never be enforced on one
 *  path and forgotten on another. */
export function createStoryImageAttachment(value: unknown): StoryImageAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImageAttachmentError("An image attachment must be an object");
  }
  const record = value as Record<string, unknown>;
  const { objectId, mediaType } = record;
  if (typeof objectId !== "string" || !HASH_PATTERN.test(objectId)) {
    throw new ImageAttachmentError("objectId must be a SHA-256 hexadecimal digest");
  }
  if (!isStoredImageMediaType(mediaType)) {
    throw new ImageAttachmentError(
      `mediaType must be one of ${STORED_IMAGE_MEDIA_TYPES.join(", ")}`
    );
  }
  const width = requireDimension(record.width, "width");
  const height = requireDimension(record.height, "height");
  const byteLength = record.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1) {
    throw new ImageAttachmentError("byteLength must be a positive integer");
  }
  if ((byteLength as number) > MAX_IMAGE_OBJECT_BYTES) {
    throw new ImageAttachmentError(
      `byteLength exceeds ${MAX_IMAGE_OBJECT_BYTES} bytes`
    );
  }
  return { objectId, mediaType, width, height, byteLength: byteLength as number };
}

/** Validate the ordered list a story part carries. Absence means no images.
 *  An empty array is invalid, because absence already says that and two
 *  encodings of one fact would make two manifests that mean the same thing. */
export function assertStoryImageAttachments(
  value: unknown,
  label: string
): asserts value is readonly StoryImageAttachment[] {
  if (!Array.isArray(value)) {
    throw new ImageAttachmentError(`${label} must be an array`);
  }
  if (value.length === 0) {
    throw new ImageAttachmentError(`${label} must be absent rather than empty`);
  }
  if (value.length > MAX_ACTIVE_PROMPT_IMAGES) {
    throw new ImageAttachmentError(
      `${label} holds more than ${MAX_ACTIVE_PROMPT_IMAGES} images`
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const attachment = createStoryImageAttachment(entry);
    if (seen.has(attachment.objectId)) {
      throw new ImageAttachmentError(
        `${label} names one image more than once`
      );
    }
    seen.add(attachment.objectId);
  }
}

/** The label the TUI and the request viewer show for one attachment. 1667
 *  keeps no file name, so the position in the ordered list is the whole
 *  identity a writer sees. */
export function imageAttachmentLabel(index: number): string {
  return `Image ${index + 1}`;
}

/** The media type written as the short word a writer reads. */
export function imageMediaTypeLabel(mediaType: StoredImageMediaType): string {
  return mediaType === "image/png" ? "PNG" : "JPEG";
}
