import assert from "node:assert/strict";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeAndFsync,
  openExclusiveWrite,
  removeQuietly,
  writeAll,
  writeExclusiveFile,
  type StagingMode
} from "../shared/safe-file-write.js";

test("writeExclusiveFile writes exclusive content", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "1667-write-"));
  try {
    const file = path.join(dir, "out");
    writeExclusiveFile({ path: file, data: "hello", mode: 0o600 });
    assert.equal(readFileSync(file, "utf8"), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAll throws when the writer returns zero", () => {
  assert.throws(
    () => writeAll(1, Buffer.from("abc"), () => 0),
    /non-positive byte count/
  );
  assert.throws(
    () => writeAll(1, Buffer.from("abc"), () => -1),
    /non-positive byte count/
  );
});

test("writeAll completes when the writer returns positive counts", () => {
  let remaining = 3;
  writeAll(1, Buffer.from("abc"), (_fd, _buf, _offset, length) => {
    assert.ok(length > 0);
    remaining -= 1;
    return 1;
  });
  assert.equal(remaining, 0);
});

test("exclusive helpers honor StagingMode under a restrictive umask", () => {
  const previousUmask = process.umask(0o077);
  const dir = mkdtempSync(path.join(tmpdir(), "1667-write-umask-"));
  try {
    const modes: readonly StagingMode[] = [0o600, 0o755];
    for (const mode of modes) {
      const written = path.join(dir, `write-${mode.toString(8)}`);
      writeExclusiveFile({ path: written, data: "body", mode });
      assert.equal(
        lstatSync(written).mode & 0o777,
        mode,
        `writeExclusiveFile mode 0o${mode.toString(8)}`
      );

      const opened = path.join(dir, `open-${mode.toString(8)}`);
      const fd = openExclusiveWrite(opened, mode);
      try {
        writeAll(fd, "body");
        closeAndFsync(fd, opened);
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // Best effort.
        }
        removeQuietly(opened);
        throw error;
      }
      assert.equal(
        lstatSync(opened).mode & 0o777,
        mode,
        `openExclusiveWrite mode 0o${mode.toString(8)}`
      );
    }
  } finally {
    process.umask(previousUmask);
    rmSync(dir, { recursive: true, force: true });
  }
});
