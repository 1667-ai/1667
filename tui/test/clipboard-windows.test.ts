import { describe, expect, test } from "bun:test";
import { budgetTimeout } from "../../test/performance-budget.js";
import { MAX_SOURCE_IMAGE_BYTES } from "../../shared/image-attachment.js";
import { runClipboardHelperProcess, type ClipboardCommandRunner } from "../src/clipboard-command-runner.js";
import {
  readClipboardImageWindows,
  windowsClipboardImageCommand
} from "../src/clipboard-windows.js";

function fakeRunner(stdout: string, error: Error | null = null): ClipboardCommandRunner {
  return async () => ({ error, stdout });
}

describe("Windows clipboard image read, through the injectable seam", () => {
  test("the NO_IMAGE marker reports null, not an error", async () => {
    const result = await readClipboardImageWindows(fakeRunner("NO_IMAGE"));
    expect(result).toBeNull();
  });

  test("the TOO_LARGE marker reports null: the helper already refused the bitmap", async () => {
    const result = await readClipboardImageWindows(fakeRunner("TOO_LARGE"));
    expect(result).toBeNull();
  });

  test("a non-zero powershell.exe exit reports null", async () => {
    const result = await readClipboardImageWindows(
      fakeRunner("", new Error("powershell.exe exited with code 1"))
    );
    expect(result).toBeNull();
  });

  test("a timed-out helper reports null, the same as any other failure", async () => {
    const timeoutError = Object.assign(new Error("helper timed out"), {
      killed: true,
      signal: "SIGTERM"
    });
    const result = await readClipboardImageWindows(fakeRunner("", timeoutError));
    expect(result).toBeNull();
  });

  test("a payload with no valid base64 characters decodes to nothing, reported as no image", async () => {
    // Every character here falls outside the base64 alphabet, so Node's
    // decoder discards all of them rather than throwing: the exact failure
    // mode a malformed helper reply produces, proven without a real
    // powershell.exe malforming anything on purpose.
    const result = await readClipboardImageWindows(fakeRunner("@@@@@@@@"));
    expect(result).toBeNull();
  });

  test("a decoded payload over the Source Image byte bound is refused, a second check behind the helper's own", async () => {
    const oversized = Buffer.alloc(MAX_SOURCE_IMAGE_BYTES + 1).toString("base64");
    const result = await readClipboardImageWindows(fakeRunner(oversized));
    expect(result).toBeNull();
  });

  test("a valid small base64 payload round-trips to the exact bytes and media type", async () => {
    const written = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const result = await readClipboardImageWindows(fakeRunner(written.toString("base64")));
    expect(result).toEqual({ type: "image", mediaType: "image/png", bytes: written });
  });

  test("the built command runs powershell.exe non-interactively and carries the Job Object source", () => {
    const command = windowsClipboardImageCommand();
    expect(command[0]).toBe("powershell.exe");
    expect(command).toContain("-NonInteractive");
    expect(command.join(" ")).toContain("Set-JobMemoryLimit");
    expect(command.join(" ")).toContain("GetCurrentProcess");
  });
});

/**
 * The real helper's measured healthy wall cost, rounded up. `budgetTimeout`
 * takes this as setup work that no budget measures, because this file has no
 * budget for the helper: it checks the helper's reply, not its speed.
 */
const REAL_HELPER_WALL_MS = 1_000;

/**
 * The deadline for one real helper run. This is a hang guard, not a
 * performance budget. Nothing in this file measures how fast the helper runs.
 *
 * The old deadline was a flat 5 seconds, and it failed the CI job at random
 * (issue #267). Across 40 healthy Windows CI runs, the helper measured 470ms
 * to 2,196ms, with a median of 696ms. Every failed run measured between
 * 5,031ms and 5,757ms. The gap between those two ranges shows a crossed
 * deadline, not slow work. A hosted runner shares its cores with other jobs,
 * and its process starts and its disk reads change speed by a large factor.
 * One local run under heavy load measured 9,208ms, and the helper still gave
 * the correct NO_IMAGE reply with no error. That delay comes from the runner,
 * not from the product, which is the failure `test/performance-budget.ts`
 * describes at its top. `budgetTimeout` supplies the contention slack that
 * covers it.
 *
 * Windows sets a second, larger limit of its own. A clipboard read can wait
 * up to 30 seconds for a delayed-render owner, and Windows does not let a
 * caller change that limit. The old 5-second deadline was below the
 * platform's own worst case. This deadline stays above it.
 */
const REAL_HELPER_DEADLINE_MS = budgetTimeout([], REAL_HELPER_WALL_MS);

/**
 * The per-test timeout for the real helper test. This stays above the
 * helper deadline, so a wedged helper fails on the assertions below
 * instead of on an opaque test timeout.
 *
 * `tui/src/clipboard-windows.ts` keeps its own, much smaller deadline for
 * the same helper. That deadline is a product decision: a paste holds the
 * TUI input queue until the helper answers. This deadline only stops a
 * wedged test.
 */
const REAL_HELPER_TEST_TIMEOUT_MS = REAL_HELPER_DEADLINE_MS * 2;

describe("Windows clipboard image read, on a real machine", () => {
  test.skipIf(process.platform !== "win32")(
    "returns no image when the clipboard holds no image, proven through the real helper",
    async () => {
      // A headless CI runner's clipboard holds no image. Run the exact
      // command `readClipboardImageWindows` builds through the real
      // subprocess runner directly, rather than through the reader
      // function: the reader returns `null` both for a genuine "no image"
      // reply and for the helper failing outright, so asserting on its
      // return value alone would still pass against a syntactically broken
      // PowerShell source. Asserting on the raw runner result instead
      // proves powershell.exe started, Add-Type compiled, the Job Object
      // code did not throw, and the clipboard genuinely held no image, all
      // in one command.
      const { error, stdout } = await runClipboardHelperProcess(windowsClipboardImageCommand(), {
        timeoutMs: REAL_HELPER_DEADLINE_MS,
        maxBuffer: Math.ceil((MAX_SOURCE_IMAGE_BYTES * 4) / 3) + 4_096
      });
      expect(error).toBeNull();
      expect(stdout.trim()).toBe("NO_IMAGE");
    },
    REAL_HELPER_TEST_TIMEOUT_MS
  );

  test.skipIf(process.platform !== "win32")(
    "fails closed rather than throwing when the platform tool is absent",
    async () => {
      const result = await runClipboardHelperProcess(
        ["definitely-not-a-real-binary-1667-clipboard-test.exe"],
        { timeoutMs: 2_000, maxBuffer: 4_096 }
      );
      expect(result.error).not.toBeNull();
      expect(result.stdout).toBe("");
    }
  );
});
