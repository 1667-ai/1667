/**
 * macOS clipboard image read.
 *
 * `osascript` is the only practical way to reach `NSPasteboard`'s image
 * data from a CLI process, and macOS coerces whatever image representation
 * the pasteboard actually holds (often TIFF from a screenshot or an image
 * editor) into PNG or JPEG on request, so this never needs to know the
 * source app's native format.
 *
 * Every step follows the design's bound: an app-owned `0700` temporary
 * directory, a random `0600` file, a helper (`ulimit -f`/`-v` plus a wall-
 * clock timeout on the spawned process) that only ever writes into that
 * pre-created file, the file opened then unlinked before the bounded read
 * so its data never outlives the read, and removal on every earlier
 * terminal path. Stale files are scavenged once per process before the
 * first use, standing in for a true "at startup" hook this module has no
 * way to register itself into.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_IMAGE_BYTES, type SourceImageMediaType } from "../../shared/image-attachment.js";
import { runClipboardHelperProcess, type ClipboardCommandRunner } from "./clipboard-command-runner.js";
import type { ClipboardContent } from "./clipboard.js";

const CLIPBOARD_DIR = join(tmpdir(), "1667-clipboard-images");
const HELPER_TIMEOUT_MS = 5_000;
// ulimit -f counts 512-byte blocks. One block of headroom keeps an exact
// boundary file from being cut off mid-write before the Node-side bounded
// read gets to judge it.
const FILE_LIMIT_BLOCKS = Math.ceil((MAX_SOURCE_IMAGE_BYTES + 1) / 512) + 1;
// Generous headroom for osascript's own runtime, still bounded well under a
// runaway allocation. Best effort, like the normalizer's own memory bound
// (server/image-normalize-launcher.ts) - ulimit -v is refused outright by
// some macOS configurations, in which case the wall-clock timeout and the
// Node-side bounded read remain the real backstop.
const MEMORY_LIMIT_KB = 512 * 1024;

/** Writes whichever image class the pasteboard will coerce to, PNG first,
 *  to argv[1], and prints the media type it wrote on success or "none" when
 *  the pasteboard holds no image. */
const CLIPBOARD_APPLESCRIPT = `
on run argv
  set thePath to item 1 of argv
  try
    set imgData to (the clipboard as «class PNGf»)
    set mt to "image/png"
  on error
    try
      set imgData to (the clipboard as JPEG picture)
      set mt to "image/jpeg"
    on error
      return "none"
    end try
  end try
  try
    set fileRef to open for access POSIX file thePath with write permission
    set eof fileRef to 0
    write imgData to fileRef
    close access fileRef
  on error
    try
      close access POSIX file thePath
    end try
    return "none"
  end try
  return mt
end run
`;

let scavenged = false;

/**
 * Read the clipboard image through `osascript`, or through an injected
 * `runner` in a test so the marker handling and the bounded file read below
 * are provable without spawning a real process. Every production caller
 * keeps the default, the real subprocess runner.
 */
export async function readClipboardImageMacOS(
  runner: ClipboardCommandRunner = runClipboardHelperProcess
): Promise<ClipboardContent | null> {
  await ensureScavenged();
  await mkdir(CLIPBOARD_DIR, { recursive: true, mode: 0o700 }).catch(() => { /* best effort */ });
  const path = join(CLIPBOARD_DIR, `${randomBytes(16).toString("hex")}.tmp`);
  try {
    // Pre-create the 0600 target so the helper only ever writes into an
    // already-correctly-permissioned file; "open for access" on an
    // existing file leaves its mode alone.
    const created = await open(path, "wx", 0o600).catch(() => null);
    if (created === null) return null;
    await created.close();

    const mediaType = await runClipboardImageHelper(path, runner);
    if (mediaType === null) {
      await unlink(path).catch(() => { /* nothing usable was written */ });
      return null;
    }
    // Open then unlink: the bytes stay reachable through the handle for the
    // bounded read below, but the path itself never lingers on disk.
    const handle = await open(path, "r").catch(() => null);
    await unlink(path).catch(() => { /* already gone */ });
    if (handle === null) return null;
    try {
      const bytes = await readBoundedHandle(handle, MAX_SOURCE_IMAGE_BYTES);
      return bytes === null ? null : { type: "image", mediaType, bytes };
    } finally {
      await handle.close().catch(() => { /* already closing */ });
    }
  } catch {
    await unlink(path).catch(() => { /* best effort on every earlier terminal path */ });
    return null;
  }
}

/** The exact `bash`/`osascript` invocation the real runner spawns, exposed
 *  so a test can assert its shape without executing it. */
export function macosClipboardImageHelperCommand(path: string): readonly string[] {
  return [
    "bash",
    "-c",
    `ulimit -f ${FILE_LIMIT_BLOCKS} 2>/dev/null; ulimit -v ${MEMORY_LIMIT_KB} 2>/dev/null; exec osascript -e "$1" "$2"`,
    "bash",
    CLIPBOARD_APPLESCRIPT,
    path
  ];
}

async function runClipboardImageHelper(
  path: string,
  runner: ClipboardCommandRunner
): Promise<SourceImageMediaType | null> {
  const { error, stdout } = await runner(macosClipboardImageHelperCommand(path), {
    timeoutMs: HELPER_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4_096
  });
  if (error !== null) return null;
  const marker = stdout.trim();
  return marker === "image/png" || marker === "image/jpeg" ? marker : null;
}

/** Read a whole already-open handle, bounded by a stat check before any
 *  allocation, the same shape as `server/import-file.ts`'s
 *  `readImportBytes`, adapted for a handle this module already opened
 *  rather than a path it would open a second time. */
async function readBoundedHandle(handle: FileHandle, maxBytes: number): Promise<Uint8Array | null> {
  const info = await handle.stat();
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
  const bytes = Buffer.alloc(info.size);
  let total = 0;
  while (total < bytes.length) {
    const result = await handle.read(bytes, total, bytes.length - total, total);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  return total === info.size ? bytes.subarray(0, total) : null;
}

async function ensureScavenged(): Promise<void> {
  if (scavenged) return;
  scavenged = true;
  try {
    const entries = await readdir(CLIPBOARD_DIR);
    await Promise.all(entries.map((name) => rm(join(CLIPBOARD_DIR, name), { force: true })));
  } catch {
    // No directory yet, or nothing to scavenge.
  }
}
