import { describe, expect, test } from "bun:test";
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

describe("Windows clipboard image read, on a real machine", () => {
  test("returns no image when the clipboard holds no image", async () => {
    if (process.platform !== "win32") return;
    // A headless CI runner's clipboard holds no image. Assert that
    // honestly instead of skipping, so this test proves the real
    // powershell.exe helper's no-image path on every Windows CI run.
    const result = await readClipboardImageWindows();
    expect(result).toBeNull();
  });

  test("fails closed rather than throwing when the platform tool is absent", async () => {
    if (process.platform !== "win32") return;
    const result = await runClipboardHelperProcess(
      ["definitely-not-a-real-binary-1667-clipboard-test.exe"],
      { timeoutMs: 2_000, maxBuffer: 4_096 }
    );
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });
});
