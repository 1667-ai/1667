/**
 * The seam both platform clipboard image helpers spawn a bounded subprocess
 * through: `tui/src/clipboard-macos.ts`'s `osascript` helper and
 * `tui/src/clipboard-windows.ts`'s `powershell.exe` helper.
 *
 * Production code always uses `runClipboardHelperProcess`, the real
 * `execFile` wrapper. A test injects a fake `ClipboardCommandRunner`
 * instead, so the parsing, bounding, and failure handling downstream of a
 * subprocess result is provable everywhere, without a real platform binary.
 */
import { execFile } from "node:child_process";

export interface ClipboardCommandRunnerOptions {
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly killSignal?: NodeJS.Signals;
}

export interface ClipboardCommandResult {
  readonly error: Error | null;
  readonly stdout: string;
}

export type ClipboardCommandRunner = (
  command: readonly string[],
  options: ClipboardCommandRunnerOptions
) => Promise<ClipboardCommandResult>;

/**
 * The real subprocess runner every production call site uses.
 *
 * `error !== null` covers a non-zero exit, a timeout, and a missing
 * executable alike: Node reports all three the same way, as a callback
 * error, never a thrown exception. A caller that wants to fail closed on any
 * of the three only has to check one thing.
 */
export const runClipboardHelperProcess: ClipboardCommandRunner = (command, options) => {
  const executable = command[0];
  if (executable === undefined) {
    return Promise.resolve({ error: new Error("empty clipboard helper command"), stdout: "" });
  }
  return new Promise((resolve) => {
    execFile(executable, command.slice(1), {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      killSignal: options.killSignal,
      windowsHide: true
    }, (error, stdout) => resolve({ error, stdout }));
  });
};
