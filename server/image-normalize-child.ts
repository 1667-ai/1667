/**
 * The child process body for one image normalization.
 *
 * `server/image-normalize-launcher.ts` runs this in a fresh, dedicated
 * process for every Source Image. A malformed or truncated payload can make
 * photon raise a WASM trap that leaves the loaded module instance unsafe to
 * reuse (`server/image-photon.ts`), so this process normalizes at most one
 * image and then exits; a corrupted instance never outlives its process.
 *
 * Wire shape: the parent writes the Source Image bytes to this process's
 * stdin and closes it. This process replies over the `ipc` channel with one
 * `ChildResultMessage`, and, only on success, writes the Normalized Image
 * bytes to stdout. Nothing here writes an image byte, or a base64
 * character, to stderr or to a log: stderr carries only the JSON parse
 * failure text below, which names no image content.
 */
import { fileURLToPath } from "node:url";
import {
  MAX_SOURCE_IMAGE_BYTES,
  type StoredImageMediaType
} from "../shared/image-attachment.js";
import { normalizeImage } from "./image-normalize.js";
import { ServiceError, type ServiceErrorCode } from "./errors.js";

export const NORMALIZE_IMAGE_CHILD_FLAG = "--normalize-image-child";
const MEDIA_TYPE_FLAG = "--media-type";

export type ChildResultMessage =
  | {
      readonly ok: true;
      readonly mediaType: StoredImageMediaType;
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly code: ServiceErrorCode;
      readonly message: string;
    };

/**
 * Read `process.stdin` fully, refusing to buffer past `maxBytes` plus one so
 * an over-limit stream is detected without ever holding a full copy of the
 * excess.
 */
function readBoundedStdin(maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        process.stdin.destroy();
        reject(new ServiceError(413, "The image input exceeded the byte limit.", "image_source_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("error", (error) => reject(error));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function declaredMediaTypeFrom(argv: readonly string[]): string | undefined {
  const index = argv.indexOf(MEDIA_TYPE_FLAG);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Optional test-only stall, entirely separate from real normalization work.
 * A real Source Image can never take long enough to prove that the
 * launcher's deadline kills a process stuck in synchronous decode or
 * encode; this environment variable lets a test hold the child's single
 * thread busy for an exact duration instead. Production code never sets it.
 */
function applyDebugStall(): void {
  const raw = process.env.AI_1667_IMAGE_NORMALIZE_TEST_STALL_MS;
  if (raw === undefined) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait: a real synchronous decode or encode also blocks the event
    // loop, so only a wall-clock, out-of-process deadline can catch it.
  }
}

/**
 * Optional test-only retained allocation, so a test can prove the launcher's
 * memory watchdog kills a child regardless of what the child is doing.
 * Production code never sets this variable.
 */
function applyDebugAllocation(): void {
  const raw = process.env.AI_1667_IMAGE_NORMALIZE_TEST_ALLOCATE_MB;
  if (raw === undefined) return;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return;
  const retained: Buffer[] = [];
  for (let index = 0; index < megabytes; index += 1) {
    retained.push(Buffer.alloc(1024 * 1024, 7));
  }
  // Hold a wall-clock beat so the parent's poll has a chance to observe the
  // allocation before this process would otherwise exit.
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (retained.length > 0 && retained[0]!.byteLength === 0) break;
  }
}

/**
 * The whole child body: read bounded input, normalize it, report the
 * result. Every failure path replies with a `ChildResultMessage` before
 * this process exits, so the launcher never has to guess why a child ended.
 */
export async function runImageNormalizeChild(argv: readonly string[]): Promise<void> {
  applyDebugStall();
  try {
    const sourceBytes = await readBoundedStdin(MAX_SOURCE_IMAGE_BYTES + 1);
    // Applied only after stdin is fully received, not at process startup.
    // On Windows, the launcher holds the child's stdin, and therefore this
    // point, until its Job Object assignment has actually settled (see
    // `sendChildInput` in `server/image-normalize-launcher.ts`); allocating
    // before that point would let a test commit memory before any kernel
    // ceiling exists to refuse it, proving nothing about the ceiling itself.
    applyDebugAllocation();
    const declaredMediaType = declaredMediaTypeFrom(argv);
    const result = await normalizeImage(sourceBytes, declaredMediaType);
    await writeStdout(result.bytes);
    send({
      ok: true,
      mediaType: result.mediaType,
      width: result.width,
      height: result.height,
      byteLength: result.bytes.byteLength
    });
    process.exitCode = 0;
  } catch (error) {
    send(failureMessage(error));
    process.exitCode = 1;
  }
}

function failureMessage(error: unknown): ChildResultMessage {
  if (error instanceof ServiceError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: "image_normalization_failed",
    message: "The image could not be normalized."
  };
}

function send(message: ChildResultMessage): void {
  process.send?.(message);
}

function writeStdout(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The one-line hook a future compiled entrypoint adds to reach this process
 * body from the packaged executable's own main dispatch, matching the shape
 * `tui/src/standalone.ts` already uses for
 * `server/supervised-serve-child-bootstrap.ts`. This module is outside that
 * file's ownership, so the hook itself is not wired here; this function is
 * ready for a one-line `await runImageNormalizeChildBootstrap(argv)` call.
 */
export async function runImageNormalizeChildBootstrap(argv: readonly string[]): Promise<void> {
  await runImageNormalizeChild(argv);
}

/**
 * Self-dispatch for source-mode execution: `server/image-normalize-launcher.ts`
 * spawns this exact file as the child's entrypoint when running under `tsx`
 * or `bun run` from source (see `childSpawnCommand` there), so this file
 * must be able to run standalone, the same way `tui/src/standalone.ts` does
 * for the whole application.
 */
if (isDirectlyExecutedAsChild()) {
  await runImageNormalizeChild(process.argv.slice(2));
}

function isDirectlyExecutedAsChild(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || !process.argv.includes(NORMALIZE_IMAGE_CHILD_FLAG)) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}
