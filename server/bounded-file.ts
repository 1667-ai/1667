import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { noFollowFlag } from "./data-directory-file-read.js";
import { StoryFormatError } from "./story-format-facts.js";
import {
  unsealVaultFileForPath,
  vaultStoredByteLimit
} from "./vault-key-registry.js";

export class FileSizeLimitError extends StoryFormatError {
  constructor(message: string) {
    super(message);
    this.name = "FileSizeLimitError";
  }
}

/** Read one regular file while bounding allocation and detecting size races. */
export async function readBoundedFile(file: string, maxBytes: number, label: string): Promise<Buffer> {
  const storedMaxBytes = vaultStoredByteLimit(file, maxBytes);
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile()) throw new StoryFormatError(`${label} is not a regular file`);
    if (info.size > storedMaxBytes) throw new FileSizeLimitError(`${label} exceeds its ${maxBytes}-byte size limit`);
    const allocation = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < allocation.length) {
      const { bytesRead } = await handle.read(allocation, total, allocation.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new StoryFormatError(`${label} changed size while being read`);
    const plaintext = unsealVaultFileForPath(file, allocation.subarray(0, total));
    if (plaintext.byteLength > maxBytes) {
      throw new FileSizeLimitError(`${label} exceeds its ${maxBytes}-byte size limit`);
    }
    return plaintext;
  } finally {
    await handle?.close();
  }
}
