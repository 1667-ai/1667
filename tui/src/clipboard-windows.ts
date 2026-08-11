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
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { MAX_SOURCE_IMAGE_BYTES } from "../../shared/image-attachment.js";
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
 * true for an ordinary child `powershell.exe` this module spawns.
 */
const CLIPBOARD_IMAGE_HELPER = `
Add-Type -Namespace ClipboardImage -Name Job -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
'@

function Set-CommitLimit([long]$bytes) {
  $job = [ClipboardImage.Job]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { return }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: BasicLimitInformation (48 bytes on
  # x64, LimitFlags at offset 32) then three 8-byte size_t fields. Setting
  # only JOB_OBJECT_LIMIT_JOB_MEMORY (0x200) and JobMemoryLimit keeps every
  # other field at its already-zeroed default.
  $size = 72
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    for ($i = 0; $i -lt $size; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, 32, 0x200)
    [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, 40, $bytes)
    [void][ClipboardImage.Job]::SetInformationJobObject($job, 9, $buf, [uint32]$size)
    [void][ClipboardImage.Job]::AssignProcessToJobObject($job, [ClipboardImage.Job]::GetCurrentProcess())
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}

Set-CommitLimit(__COMMIT_LIMIT_BYTES__)

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

export async function readClipboardImageWindows(): Promise<ClipboardContent | null> {
  const command = windowsClipboardImageCommand();
  const executable = command[0];
  if (executable === undefined) return null;
  const output = await new Promise<string | null>((resolve) => {
    execFile(executable, command.slice(1), {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true
    }, (error, stdout) => resolve(error === null ? stdout : null));
  });
  if (output === null || output === NO_IMAGE_MARKER || output === TOO_LARGE_MARKER) return null;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(output, "base64");
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
