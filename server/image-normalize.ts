/**
 * The Normalized Image algorithm: decode a Source Image, correct its
 * orientation, resize it to fit the Normalized Image bounds, and re-encode
 * it as PNG or JPEG. `server/image-normalize-child.ts` runs this inside a
 * dedicated, bounded child process; this module holds no process-boundary
 * code of its own, so a caller that already trusts its input bytes can call
 * it directly (a test, for example).
 *
 * The reduction sequence and the orientation math below are load-bearing:
 * see the comments on `rotateClockwise90` and `encodeOpaque` for what each
 * one proves and why it is written the way it is.
 */
import {
  MAX_IMAGE_OBJECT_BYTES,
  MAX_NORMALIZED_IMAGE_DIMENSION,
  type StoredImageMediaType
} from "../shared/image-attachment.js";
import { parseImageHeader, type ExifOrientation } from "./image-header.js";
import { loadPhoton, type Photon } from "./image-photon.js";
import { ServiceError } from "./errors.js";

type PhotonImageInstance = InstanceType<Photon["PhotonImage"]>;

export interface NormalizedImage {
  readonly mediaType: StoredImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/** JPEG quality steps tried at each dimension step, highest first. Four
 *  steps span the useful range: 82 keeps photographic detail, 35 is the
 *  point past which further loss rarely buys enough bytes to matter. */
const JPEG_QUALITY_LADDER: readonly number[] = [82, 65, 50, 35];
/** Each dimension step is three quarters of the one before it. */
const DIMENSION_SHRINK_FACTOR = 0.75;
/** The ladder stops shrinking here. Below this, a further step buys so few
 *  bytes that continuing could only mask a genuinely incompressible image. */
const MIN_REDUCTION_DIMENSION = 64;

/**
 * Decode `sourceBytes`, correct its orientation, resize it to fit the
 * Normalized Image bounds, and re-encode it as PNG or JPEG.
 *
 * @param declaredMediaType The content type the caller claimed, when one
 *   exists. Passed straight through to `parseImageHeader`.
 */
export async function normalizeImage(
  sourceBytes: Uint8Array,
  declaredMediaType?: string
): Promise<NormalizedImage> {
  const header = parseImageHeader(sourceBytes, declaredMediaType);
  const photon = await loadPhoton();
  const decoded = decode(photon, sourceBytes);
  if (decoded.get_width() !== header.width || decoded.get_height() !== header.height) {
    decoded.free();
    throw new ServiceError(
      400,
      "The decoded image did not match its header.",
      "image_invalid"
    );
  }
  const oriented = applyOrientation(photon, decoded, header.orientation);
  const transparent = hasTransparency(oriented);
  try {
    return transparent
      ? encodeTransparent(photon, oriented)
      : encodeOpaque(photon, oriented, header.mediaType === "image/png");
  } finally {
    oriented.free();
  }
}

function decode(photon: Photon, sourceBytes: Uint8Array): PhotonImageInstance {
  try {
    return photon.PhotonImage.new_from_byteslice(sourceBytes);
  } catch (error) {
    // A malformed or truncated payload that passed header validation can
    // still make photon's decoder raise a WASM trap. The trap message names
    // no bytes; it is safe to keep as a diagnostic cause.
    throw new ServiceError(
      400,
      "The image could not be decoded.",
      "image_invalid",
      { cause: error }
    );
  }
}

/**
 * Rotate an image 90 degrees clockwise by permuting its raw RGBA pixels.
 *
 * `photon.rotate` takes an arbitrary angle and is built for that general
 * case. Measured against a right-angle input, it allocates the correctly
 * swapped canvas but leaves most of it black: an 8x4 test image rotated 90
 * degrees came back as a 4x8 canvas with real pixels in only two of its four
 * columns. Composing this exact permutation instead is a closed-form
 * right-angle rotation with no resampling, so there is no canvas-sizing
 * question to get right: source (x, y) always lands at destination
 * (height-1-y, x), and the destination is exactly height-by-width. Orient
 * applies this to the full-size decoded raster before the Lanczos resize
 * runs, so photon's own resize is the only step that ever resamples pixels.
 */
function rotateClockwise90(photon: Photon, image: PhotonImageInstance): PhotonImageInstance {
  const width = image.get_width();
  const height = image.get_height();
  const source = image.get_raw_pixels();
  const destination = new Uint8Array(width * height * 4);
  const destinationWidth = height;
  for (let y = 0; y < height; y += 1) {
    const destinationX = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (y * width + x) * 4;
      const destinationIndex = (x * destinationWidth + destinationX) * 4;
      destination[destinationIndex] = source[sourceIndex]!;
      destination[destinationIndex + 1] = source[sourceIndex + 1]!;
      destination[destinationIndex + 2] = source[sourceIndex + 2]!;
      destination[destinationIndex + 3] = source[sourceIndex + 3]!;
    }
  }
  return new photon.PhotonImage(destination, destinationWidth, width);
}

function rotateClockwise(
  photon: Photon,
  image: PhotonImageInstance,
  quarterTurns: number
): PhotonImageInstance {
  let current = image;
  for (let turn = 0; turn < quarterTurns; turn += 1) {
    const rotated = rotateClockwise90(photon, current);
    current.free();
    current = rotated;
  }
  return current;
}

/**
 * Apply the EXIF orientation photon itself ignores. `fliph` and `flipv`
 * mutate their argument in place and were verified pixel-correct; only
 * `rotate` needed the replacement above. The table below is the standard
 * EXIF orientation-to-transform mapping.
 */
function applyOrientation(
  photon: Photon,
  image: PhotonImageInstance,
  orientation: ExifOrientation
): PhotonImageInstance {
  if (orientation === 2 || orientation === 5 || orientation === 7) {
    photon.fliph(image);
  } else if (orientation === 4) {
    photon.flipv(image);
    return image;
  }
  const quarterTurns = (orientation === 6 || orientation === 7) ? 1
    : orientation === 3 ? 2
    : (orientation === 5 || orientation === 8) ? 3
    : 0;
  return quarterTurns === 0 ? image : rotateClockwise(photon, image, quarterTurns);
}

/** Any alpha byte below 255 means the image has transparency the design
 *  requires 1667 to keep. */
function hasTransparency(image: PhotonImageInstance): boolean {
  const pixels = image.get_raw_pixels();
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! < 255) return true;
  }
  return false;
}

/** The largest dimensions that fit `cap` on the longest side without
 *  upscaling past the source. Returns the source dimensions unchanged when
 *  they already fit, so a small source is never resampled for no reason. */
function fitWithinCap(
  width: number,
  height: number,
  cap: number
): { readonly width: number; readonly height: number } {
  const longestSide = Math.max(width, height);
  if (longestSide <= cap) return { width, height };
  const scale = cap / longestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function resizeTo(
  photon: Photon,
  image: PhotonImageInstance,
  dimensions: { readonly width: number; readonly height: number }
): PhotonImageInstance {
  if (dimensions.width === image.get_width() && dimensions.height === image.get_height()) {
    return image;
  }
  return photon.resize(
    image,
    dimensions.width,
    dimensions.height,
    photon.SamplingFilter.Lanczos3
  );
}

/**
 * Reduce PNG dimensions, only, until an opaque or transparent Normalized
 * Image fits the byte bound. This is the sole reduction axis for PNG: PNG
 * has no quality knob, and transparency must never be dropped to meet a
 * limit, so shrinking is the only lever left.
 */
function reduceByDimension(
  photon: Photon,
  source: PhotonImageInstance,
  encode: (candidate: PhotonImageInstance) => Uint8Array
): NormalizedImage | null {
  let cap = Math.min(
    Math.max(source.get_width(), source.get_height()),
    MAX_NORMALIZED_IMAGE_DIMENSION
  );
  for (;;) {
    const dimensions = fitWithinCap(source.get_width(), source.get_height(), cap);
    const candidate = resizeTo(photon, source, dimensions);
    const bytes = encode(candidate);
    if (candidate !== source) candidate.free();
    if (bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES) {
      return { mediaType: "image/png", width: dimensions.width, height: dimensions.height, bytes };
    }
    if (cap <= MIN_REDUCTION_DIMENSION) return null;
    cap = Math.max(MIN_REDUCTION_DIMENSION, Math.floor(cap * DIMENSION_SHRINK_FACTOR));
  }
}

function encodeTransparent(photon: Photon, oriented: PhotonImageInstance): NormalizedImage {
  const result = reduceByDimension(photon, oriented, (candidate) => candidate.get_bytes());
  if (result === null) {
    throw new ServiceError(
      422,
      "The image could not be reduced to fit the size limit without losing transparency.",
      "image_normalization_failed"
    );
  }
  return result;
}

/**
 * Try PNG once, at the natural fit-to-cap size, for an opaque source that
 * was already PNG: many opaque PNGs are line art or screenshots that PNG
 * compresses well, and re-encoding them as JPEG would add loss for no
 * reason. Anything else, and anything the PNG attempt could not fit, goes
 * through the one deterministic quality-then-dimension JPEG ladder: try
 * every quality step at the current size, and only shrink the dimensions
 * once every quality step has failed at the size before it.
 */
function encodeOpaque(
  photon: Photon,
  oriented: PhotonImageInstance,
  sourceWasPng: boolean
): NormalizedImage {
  if (sourceWasPng) {
    const cap = Math.min(
      Math.max(oriented.get_width(), oriented.get_height()),
      MAX_NORMALIZED_IMAGE_DIMENSION
    );
    const dimensions = fitWithinCap(oriented.get_width(), oriented.get_height(), cap);
    const candidate = resizeTo(photon, oriented, dimensions);
    const bytes = candidate.get_bytes();
    if (candidate !== oriented) candidate.free();
    if (bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES) {
      return { mediaType: "image/png", width: dimensions.width, height: dimensions.height, bytes };
    }
  }
  let cap = Math.min(
    Math.max(oriented.get_width(), oriented.get_height()),
    MAX_NORMALIZED_IMAGE_DIMENSION
  );
  for (;;) {
    const dimensions = fitWithinCap(oriented.get_width(), oriented.get_height(), cap);
    const candidate = resizeTo(photon, oriented, dimensions);
    for (const quality of JPEG_QUALITY_LADDER) {
      const bytes = candidate.get_bytes_jpeg(quality);
      if (bytes.byteLength <= MAX_IMAGE_OBJECT_BYTES) {
        if (candidate !== oriented) candidate.free();
        return { mediaType: "image/jpeg", width: dimensions.width, height: dimensions.height, bytes };
      }
    }
    if (candidate !== oriented) candidate.free();
    if (cap <= MIN_REDUCTION_DIMENSION) {
      throw new ServiceError(
        422,
        "The image could not be reduced to fit the size limit.",
        "image_normalization_failed"
      );
    }
    cap = Math.max(MIN_REDUCTION_DIMENSION, Math.floor(cap * DIMENSION_SHRINK_FACTOR));
  }
}
