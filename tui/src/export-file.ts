import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * An exported `.md` is a hand-off artifact 1667 never reads back. It
 * carries no anchors and no state, so writing one is the whole feature.
 */
export interface StoryExportRequest {
  readonly directory: string;
  readonly title: string;
  readonly markdown: string;
  /** Overwrite the unsuffixed name instead of picking the next free one. */
  readonly force?: boolean;
  /** Reserve this numeric suffix for a duplicate title in one export batch. */
  readonly collisionIndex?: number;
}

/** A caller-selected extension from the formats this program writes. */
export type ExportExtension = ".md" | ".story" | ".scenario" | ".lorebook";

export interface ExportFileRequest {
  readonly directory: string;
  readonly title: string;
  readonly extension: ExportExtension;
  readonly content: string;
  /** Overwrite the allocated name instead of requiring it to be new. */
  readonly force?: boolean;
  /** Reserve this numeric suffix for a duplicate title in one export batch. */
  readonly collisionIndex?: number;
}

/** Assign unique final names within one export batch. */
export interface ExportFileAllocator {
  allocate(title: string, extension: ExportExtension): number;
}

export function createExportFileAllocator(): ExportFileAllocator {
  const reserved = new Set<string>();
  return {
    allocate(title, extension) {
      const base = exportFileBase(title);
      for (let collisionIndex = 1; ; collisionIndex += 1) {
        const name = exportFileName(base, extension, collisionIndex);
        const reservation = name.normalize("NFC").toLowerCase();
        if (reserved.has(reservation)) continue;
        reserved.add(reservation);
        return collisionIndex;
      }
    }
  };
}

export async function writeStoryExport(
  request: StoryExportRequest
): Promise<string> {
  return await writeExportFile({
    directory: request.directory,
    title: request.title,
    extension: ".md",
    content: request.markdown,
    force: request.force,
    collisionIndex: request.collisionIndex
  });
}

/**
 * Write a hand-off export. Format extensions are selected by trusted callers,
 * while story titles still go through the one filename boundary below.
 */
export async function writeExportFile(
  request: ExportFileRequest
): Promise<string> {
  const base = exportFileBase(request.title);
  const first = request.collisionIndex ?? 1;
  if (!Number.isSafeInteger(first) || first < 1) {
    throw new Error("export collision index must be a positive integer");
  }
  if (request.force === true) {
    const file = exportPath(request.directory, base, request.extension, first);
    await replaceExportFile(file, request.content);
    return file;
  }
  for (let attempt = first; ; attempt += 1) {
    const file = exportPath(request.directory, base, request.extension, attempt);
    try {
      // The exclusive create is also the availability check. An access-first
      // path races another export that creates the same name between calls.
      await writeFile(file, request.content, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

export function exportFileBase(title: string): string {
  let name = title
    .replace(/[\u0000-\u001F\u007F-\u009F\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "") || "story";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    name = `_${name}`;
  }
  // Stay well under the 255-byte filesystem component limit, leaving room
  // for an extension and a numeric collision suffix.
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > 120) {
    let bytes = 0;
    let prefix = "";
    for (const scalar of name) {
      const scalarBytes = encoder.encode(scalar).length;
      if (bytes + scalarBytes > 120) break;
      prefix += scalar;
      bytes += scalarBytes;
    }
    name = prefix.trimEnd();
  }
  return name || "story";
}

function exportPath(
  directory: string,
  base: string,
  extension: ExportExtension,
  collisionIndex: number
): string {
  return resolve(
    directory,
    exportFileName(base, extension, collisionIndex)
  );
}

function exportFileName(
  base: string,
  extension: ExportExtension,
  collisionIndex: number
): string {
  return `${base}${collisionIndex === 1 ? "" : `-${collisionIndex}`}${extension}`;
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

/** Publish complete bytes over the final directory entry, not through it. */
async function replaceExportFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
