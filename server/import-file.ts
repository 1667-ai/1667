import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { MAX_IMPORT_BYTES } from "../shared/types.js";
import { noFollowFlag } from "./data-directory-file-read.js";

export interface ImportReadOptions {
  /** A narrower caller-specific ceiling. The global import ceiling still applies. */
  readonly maximumBytes?: number;
  /** The error shown when the caller-specific ceiling rejects the file. */
  readonly tooLargeMessage?: string;
}

/** Read one bounded, regular import source without following a final link.
 *
 * Every command that reads a file the writer named goes through here, so the
 * bounds hold whether the caller is the packaged binary or a workspace script.
 * A second reader is a second set of rules, and the weaker one wins by
 * accident. */
export async function readImportBytes(
  file: string,
  options: ImportReadOptions = {}
): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK makes opening a FIFO return immediately; the retained handle's
    // metadata then rejects every non-regular source before any content read.
    handle = await open(
      file,
      constants.O_RDONLY
        | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
        | noFollowFlag()
    );
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("import source is not a regular file");
    const maximumBytes = Math.min(options.maximumBytes ?? MAX_IMPORT_BYTES, MAX_IMPORT_BYTES);
    if (info.size > maximumBytes) {
      if (options.tooLargeMessage !== undefined) throw new Error(options.tooLargeMessage);
      throw new Error(
        `file is ${Math.round(info.size / 1e6)}MB — larger than the `
          + `${maximumBytes / 1e6}MB import limit`
      );
    }
    const bytes = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total !== info.size) throw new Error("import source changed size while being read");
    return bytes.subarray(0, total);
  } finally {
    await handle?.close();
  }
}
