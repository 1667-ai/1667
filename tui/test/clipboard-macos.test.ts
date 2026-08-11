import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { MAX_SOURCE_IMAGE_BYTES } from "../../shared/image-attachment.js";
import { runClipboardHelperProcess, type ClipboardCommandRunner } from "../src/clipboard-command-runner.js";
import {
  macosClipboardImageHelperCommand,
  readClipboardImageMacOS
} from "../src/clipboard-macos.js";

/** Every fake runner below stands in for the `bash`/`osascript` subprocess.
 *  `macosClipboardImageHelperCommand` always puts the pre-created target
 *  path last, so a fake that needs to act like the AppleScript helper reads
 *  it from there and writes real bytes through real `node:fs` calls. Only
 *  the "spawn a platform binary" step is faked; everything downstream, the
 *  file open, the stat-bounded read, and the unlink, runs for real on every
 *  platform, including this one. */
function helperPath(command: readonly string[]): string {
  const path = command[command.length - 1];
  if (path === undefined) throw new Error("command carried no target path");
  return path;
}

function fakeRunner(
  respond: (path: string) => Promise<{ error: Error | null; stdout: string }>
): ClipboardCommandRunner {
  return async (command) => respond(helperPath(command));
}

describe("macOS clipboard image read, through the injectable seam", () => {
  test("the pasteboard holding no image reports null, not an error", async () => {
    const result = await readClipboardImageMacOS(
      fakeRunner(async () => ({ error: null, stdout: "none" }))
    );
    expect(result).toBeNull();
  });

  test("an unrecognized marker reports null rather than trusting it", async () => {
    const result = await readClipboardImageMacOS(
      fakeRunner(async () => ({ error: null, stdout: "image/tiff" }))
    );
    expect(result).toBeNull();
  });

  test("a non-zero osascript exit reports null", async () => {
    const result = await readClipboardImageMacOS(
      fakeRunner(async () => ({ error: new Error("osascript exited with code 1"), stdout: "" }))
    );
    expect(result).toBeNull();
  });

  test("a timed-out helper reports null, the same as any other failure", async () => {
    const timeoutError = Object.assign(new Error("helper timed out"), {
      killed: true,
      signal: "SIGKILL"
    });
    const result = await readClipboardImageMacOS(
      fakeRunner(async () => ({ error: timeoutError, stdout: "" }))
    );
    expect(result).toBeNull();
  });

  test("a file over the Source Image byte bound is refused before any bytes reach the caller", async () => {
    const result = await readClipboardImageMacOS(fakeRunner(async (path) => {
      await writeFile(path, Buffer.alloc(MAX_SOURCE_IMAGE_BYTES + 1));
      return { error: null, stdout: "image/png" };
    }));
    expect(result).toBeNull();
  });

  test("an empty file is treated as no image, not a zero-byte one", async () => {
    const result = await readClipboardImageMacOS(fakeRunner(async (path) => {
      await writeFile(path, Buffer.alloc(0));
      return { error: null, stdout: "image/png" };
    }));
    expect(result).toBeNull();
  });

  test("a valid small PNG marker and file round-trip to the exact bytes written", async () => {
    const written = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
    let seenPath = "";
    const result = await readClipboardImageMacOS(fakeRunner(async (path) => {
      seenPath = path;
      await writeFile(path, written);
      return { error: null, stdout: "image/png\n" };
    }));
    expect(result).toEqual({ type: "image", mediaType: "image/png", bytes: written });
    // The path the helper wrote into is unlinked before this function
    // returns, whether it succeeds or fails: the file never lingers.
    let stillOnDisk = true;
    try {
      await readFile(seenPath);
    } catch {
      stillOnDisk = false;
    }
    expect(stillOnDisk).toBe(false);
  });

  test("a valid JPEG marker is passed through as the reported media type", async () => {
    const written = Buffer.from([255, 216, 255, 224]);
    const result = await readClipboardImageMacOS(fakeRunner(async (path) => {
      await writeFile(path, written);
      return { error: null, stdout: "image/jpeg" };
    }));
    expect(result).toEqual({ type: "image", mediaType: "image/jpeg", bytes: written });
  });

  test("the helper command names bash, osascript, and the target path in order", () => {
    const command = macosClipboardImageHelperCommand("/tmp/example-path");
    expect(command[0]).toBe("bash");
    expect(command.join(" ")).toContain("osascript");
    expect(command[command.length - 1]).toBe("/tmp/example-path");
  });
});

describe("macOS clipboard image read, on a real machine", () => {
  test("returns no image when the clipboard holds no image", async () => {
    if (process.platform !== "darwin") return;
    // A headless CI runner's clipboard holds no image. Assert that
    // honestly instead of skipping, so this test proves the real
    // `osascript` helper's no-image path on every macOS CI run.
    const result = await readClipboardImageMacOS();
    expect(result).toBeNull();
  });

  test("fails closed rather than throwing when the platform tool is absent", async () => {
    if (process.platform !== "darwin") return;
    const result = await runClipboardHelperProcess(
      ["/definitely/not/a/real/binary-1667-clipboard-test"],
      { timeoutMs: 2_000, maxBuffer: 4_096 }
    );
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });
});

