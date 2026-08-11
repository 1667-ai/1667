/**
 * Windows and WSL clipboard image read.
 *
 * `Clipboard.GetImage()` runs inside a short-lived `powershell.exe` helper
 * that assigns itself to a Windows Job Object with a 256 MiB commit limit
 * before touching the clipboard, so a hostile or pathological bitmap cannot
 * grow the helper past that ceiling. The helper re-encodes to PNG itself
 * and refuses to emit more than the Source Image byte bound, so Node's own
 * `maxBuffer` - a text bound on the base64 the helper prints, not a raw
 * byte bound, never has to catch a bigger failure than "the helper already
 * said no".
 *
 * WSL has no Windows clipboard of its own; `powershell.exe` on the Windows
 * host is reachable from a WSL shell on `PATH` and reads the same one.
 */
import { readFileSync } from "node:fs";
import { MAX_SOURCE_IMAGE_BYTES } from "../../shared/image-attachment.js";
import { WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE } from "../../shared/windows-job-memory-limit.js";
import { runClipboardHelperProcess, type ClipboardCommandRunner } from "./clipboard-command-runner.js";
import type { ClipboardContent } from "./clipboard.js";

const HELPER_TIMEOUT_MS = 5_000;
const JOB_OBJECT_COMMIT_LIMIT_MIB = 256;
// Base64 expands by 4/3; the helper itself refuses a bitmap whose PNG bytes
// exceed MAX_SOURCE_IMAGE_BYTES, so this only has to hold that much text
// plus encoding slack.
const MAX_BUFFER_BYTES = Math.ceil((MAX_SOURCE_IMAGE_BYTES * 4) / 3) + 4_096;

const TOO_LARGE_MARKER = "TOO_LARGE";
const NO_IMAGE_MARKER = "NO_IMAGE";

/**
 * A Job Object bounds committed memory for the whole process tree it owns.
 * `AssignProcessToJobObject` on the current process is legal as long as the
 * helper was not itself launched inside a job that forbids breakaway,
 * true for an ordinary child `powershell.exe` this module spawns. The
 * P/Invoke declarations and the limit-setting function come from
 * `shared/windows-job-memory-limit.ts`, the same source
 * `server/image-normalize-launcher.ts` uses to bound the normalizer child.
 */
const CLIPBOARD_IMAGE_HELPER = `
${WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE}
Set-JobMemoryLimit -bytes __COMMIT_LIMIT_BYTES__ -processHandle ([JobMemoryLimit.Native]::GetCurrentProcess())

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image -eq $null) {
  [Console]::Out.Write("__NO_IMAGE__")
} else {
  $stream = New-Object System.IO.MemoryStream
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  if ($bytes.Length -gt __MAX_SOURCE_IMAGE_BYTES__) {
    [Console]::Out.Write("__TOO_LARGE__")
  } else {
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  }
}
`
  .replace("__COMMIT_LIMIT_BYTES__", String(JOB_OBJECT_COMMIT_LIMIT_MIB * 1024 * 1024))
  .replace("__NO_IMAGE__", NO_IMAGE_MARKER)
  .replace("__TOO_LARGE__", TOO_LARGE_MARKER)
  .replace("__MAX_SOURCE_IMAGE_BYTES__", String(MAX_SOURCE_IMAGE_BYTES));

export function windowsClipboardImageCommand(): readonly string[] {
  return [
    "powershell.exe", "-NonInteractive", "-NoProfile", "-Command", CLIPBOARD_IMAGE_HELPER
  ];
}

/**
 * Read the clipboard image through `powershell.exe`, or through an injected
 * `runner` in a test so the marker handling, the base64 decode, and both
 * size bounds below are provable without spawning a real process. Every
 * production caller keeps the default, the real subprocess runner.
 */
export async function readClipboardImageWindows(
  runner: ClipboardCommandRunner = runClipboardHelperProcess
): Promise<ClipboardContent | null> {
  const command = windowsClipboardImageCommand();
  const { error, stdout } = await runner(command, {
    maxBuffer: MAX_BUFFER_BYTES,
    timeoutMs: HELPER_TIMEOUT_MS
  });
  if (error !== null || stdout === NO_IMAGE_MARKER || stdout === TOO_LARGE_MARKER) return null;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(stdout, "base64");
  } catch {
    return null;
  }
  // The helper already refused a bitmap over the bound; this is a second,
  // cheap check against the decoded length rather than trusting it alone.
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) return null;
  return { type: "image", mediaType: "image/png", bytes };
}

/** True inside WSL, where `process.platform` reads `"linux"` but a Windows
 *  host clipboard is reachable through `powershell.exe` on `PATH`. */
export function isWslHost(): boolean {
  if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined) return true;
  try {
    return /microsoft/iu.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}
