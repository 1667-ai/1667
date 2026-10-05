import {
  MAX_ACTIVE_PROMPT_IMAGES,
  MAX_SOURCE_IMAGE_BYTES,
  type SourceImageMediaType,
  type StoryImageAttachment
} from "../../../shared/image-attachment.js";

/** One image attached to a composer draft: staged on the server (the lease),
 * with the writer's own bytes kept in the page for the thumbnail. */
export interface DraftImage {
  readonly leaseId: string;
  readonly attachment: StoryImageAttachment;
  /** A `blob:` address of the file the writer chose, for the thumbnail only. */
  readonly previewUrl: string;
  readonly name: string;
}

export const MAX_DRAFT_IMAGES = MAX_ACTIVE_PROMPT_IMAGES;

export const IMAGE_TOO_BIG_TOAST = `That image is larger than ${Math.round(MAX_SOURCE_IMAGE_BYTES / 1_000_000)} MB.`;
export const IMAGE_KIND_TOAST = "Attach a PNG, JPEG or WebP image.";
export const IMAGE_LIMIT_TOAST = `You can attach ${MAX_DRAFT_IMAGES} images. Remove one first.`;

/** The media type of an image file, read from its first bytes (a file's own
 * name and type are the writer's guess, not the format), or `null` when it is
 * none of PNG, JPEG and WebP. The server reads the header again and refuses
 * what it cannot take. */
export function sniffImageType(bytes: Uint8Array): SourceImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** `418 KB`, `2.3 MB`: the size shown beside a thumbnail. */
export function imageSizeText(byteLength: number): string {
  const kb = byteLength / 1024;
  if (kb < 1_000) return `${Math.max(1, Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
