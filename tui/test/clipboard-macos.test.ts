import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { budgetTimeout } from "../../test/performance-budget.js";
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

/**
 * The real helper's healthy wall cost, rounded up. `budgetTimeout` takes this
 * as setup work that no budget measures, because this file has no budget for
 * the helper: it checks the helper's reply, not its speed.
 */
const REAL_HELPER_WALL_MS = 1_000;

/**
 * The deadline for one real helper run. This is a hang guard, not a
 * performance budget. Nothing in this file measures how fast the helper runs.
 *
 * The Windows helper carried the same flat 5-second deadline, and a hosted
 * runner crossed it at random (issue #267). This test has not failed that
 * way, because `osascript` starts faster than `powershell.exe`, which also
 * compiles C# through `Add-Type` on every run. The cause is not specific to
 * Windows though. A hosted runner shares its cores with other jobs, so a flat
 * wall-clock deadline measures the runner and not the product, which is the
 * failure `test/performance-budget.ts` describes at its top. The Intel macOS
 * runner is the slowest target this project builds for, and it takes the
 * largest slack from that same table.
 *
 * `tui/src/clipboard-macos.ts` keeps its own, much smaller deadline for the
 * same helper. That deadline is a product decision: a paste holds the TUI
 * input queue until the helper answers. This deadline only stops a wedged
 * test.
 */
const REAL_HELPER_DEADLINE_MS = budgetTimeout([], REAL_HELPER_WALL_MS);

/**
 * The per-test timeout for the real helper test. This stays above the helper
 * deadline, so a wedged helper fails on the assertions below instead of on an
 * opaque test timeout.
 */
const REAL_HELPER_TEST_TIMEOUT_MS = REAL_HELPER_DEADLINE_MS * 2;

describe("macOS clipboard image read, on a real machine", () => {
  test.skipIf(process.platform !== "darwin")(
    "returns no image when the clipboard holds no image, proven through the real helper",
    async () => {
      // A headless CI runner's clipboard holds no image. Run the exact
      // command `readClipboardImageMacOS` builds through the real
      // subprocess runner directly, rather than through the reader
      // function: the reader returns `null` both for a genuine "no image"
      // reply and for the helper failing outright, so asserting on its
      // return value alone would still pass against a syntactically broken
      // AppleScript source. Asserting on the raw runner result instead
      // proves `osascript` started, ran the script, and the clipboard
      // genuinely held no image, all in one command. The path argument is
      // never opened on this branch: the AppleScript returns "none" before
      // it ever tries to write a file.
      const path = join(tmpdir(), `1667-clipboard-test-${randomBytes(16).toString("hex")}.tmp`);
      const { error, stdout } = await runClipboardHelperProcess(
        macosClipboardImageHelperCommand(path),
        { timeoutMs: REAL_HELPER_DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: 4_096 }
      );
      expect(error).toBeNull();
      expect(stdout.trim()).toBe("none");
    },
    REAL_HELPER_TEST_TIMEOUT_MS
  );

  test.skipIf(process.platform !== "darwin")(
    "fails closed rather than throwing when the platform tool is absent",
    async () => {
      const result = await runClipboardHelperProcess(
        ["/definitely/not/a/real/binary-1667-clipboard-test"],
        { timeoutMs: 2_000, maxBuffer: 4_096 }
      );
      expect(result.error).not.toBeNull();
      expect(result.stdout).toBe("");
    }
  );
});

