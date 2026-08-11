import { describe, expect, test } from "bun:test";
import { runClipboardHelperProcess } from "../src/clipboard-command-runner.js";

/**
 * `runClipboardHelperProcess` is the real subprocess runner both
 * `clipboard-macos.ts` and `clipboard-windows.ts` default to. It runs on
 * every platform (it only ever executes `process.execPath`, Bun or Node's
 * own binary, here), so its own translation from an `execFile` callback
 * into `{ error, stdout }` is provable everywhere, independent of the
 * platform-specific helper scripts that use it in production.
 */
describe("the real clipboard command runner", () => {
  test("returns the exact stdout a process writes, with no error", async () => {
    const result = await runClipboardHelperProcess(
      [process.execPath, "-e", "process.stdout.write('exact-output')"],
      { timeoutMs: 5_000, maxBuffer: 4_096 }
    );
    expect(result).toEqual({ error: null, stdout: "exact-output" });
  });

  test("a non-zero exit is reported as an error, not thrown", async () => {
    const result = await runClipboardHelperProcess(
      [process.execPath, "-e", "process.exit(1)"],
      { timeoutMs: 5_000, maxBuffer: 4_096 }
    );
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });

  test("a stalled process is killed and reported as an error, not thrown", async () => {
    const started = Date.now();
    const result = await runClipboardHelperProcess(
      [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      { timeoutMs: 50, maxBuffer: 4_096 }
    );
    expect(result.error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a missing executable is reported as an error, not thrown", async () => {
    const result = await runClipboardHelperProcess(
      ["definitely-not-a-real-binary-1667-clipboard-runner-test"],
      { timeoutMs: 2_000, maxBuffer: 4_096 }
    );
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });

  test("an empty command reports an error without spawning anything", async () => {
    const result = await runClipboardHelperProcess([], { timeoutMs: 1_000, maxBuffer: 4_096 });
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
  });
});
