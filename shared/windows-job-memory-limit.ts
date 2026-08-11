/**
 * Shared PowerShell source for a Windows Job Object with a committed-memory
 * ceiling.
 *
 * A Job Object bound is enforced by the kernel. Once a process is assigned,
 * Windows refuses any allocation that would push the job's total committed
 * memory past the limit. No polling is involved.
 *
 * Two call sites share this exact P/Invoke declaration and buffer layout.
 * Writing it twice already cost one enforced bound, when an earlier round
 * cloned it and only one copy got fixed. This module is the single source
 * now:
 * - `tui/src/clipboard-windows.ts` assigns the CURRENT process, the
 *   `powershell.exe` helper itself, before it touches the clipboard.
 * - `server/image-normalize-launcher.ts` assigns a SEPARATE, already-running
 *   process, the normalizer child, by process id, from a short-lived
 *   `powershell.exe` helper it spawns right after starting that child.
 */

/**
 * The `Add-Type` P/Invoke declarations and the `Set-JobMemoryLimit`
 * function every caller needs. `Set-JobMemoryLimit` takes the byte ceiling
 * and an open process handle: it creates the job, sets
 * `JOB_OBJECT_LIMIT_JOB_MEMORY` (0x200), and assigns the handle to the job.
 * Every other `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` field stays at its
 * already-zeroed default.
 *
 * A caller appends its own trailing line: `Set-JobMemoryLimit -bytes <n>
 * -processHandle ([JobMemoryLimit.Native]::GetCurrentProcess())` for the
 * current process, or the same call against a handle from `OpenProcess` for
 * a different, already-running process.
 */
export const WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE = `
Add-Type -Namespace JobMemoryLimit -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
'@

function Set-JobMemoryLimit([long]$bytes, [IntPtr]$processHandle) {
  if ($processHandle -eq [IntPtr]::Zero) { return }
  $job = [JobMemoryLimit.Native]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { return }
  $size = 72
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    for ($i = 0; $i -lt $size; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, 32, 0x200)
    [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, 40, $bytes)
    [void][JobMemoryLimit.Native]::SetInformationJobObject($job, 9, $buf, [uint32]$size)
    [void][JobMemoryLimit.Native]::AssignProcessToJobObject($job, $processHandle)
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}
`;

/**
 * `PROCESS_TERMINATE (0x0001) | PROCESS_SET_QUOTA (0x0100)`. The exact
 * access `AssignProcessToJobObject` requires on a handle that names a
 * process other than the caller's own, which `OpenProcess` must request by
 * name because Windows grants no access by default.
 */
export const WINDOWS_JOB_OBJECT_PROCESS_ACCESS = 0x0101;
