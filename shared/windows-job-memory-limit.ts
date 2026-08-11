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
 *
 * `Set-JobMemoryLimit` returns `$true` only when both native calls,
 * `SetInformationJobObject` and `AssignProcessToJobObject`, report success.
 * Every other outcome, including a handle the caller could not open, returns
 * `$false`. A caller decides for itself what an unbounded process means; see
 * `WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER` below for how
 * `server/image-normalize-memory-bound.ts` turns that boolean into an
 * observable outcome across the `powershell.exe` process boundary.
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
 * a different, already-running process. A caller that wants to observe
 * success must check the returned boolean itself; PowerShell writes an
 * unconsumed function return value to the pipeline, so a caller that does
 * not check it (`tui/src/clipboard-windows.ts`, which stays best-effort by
 * design) must wrap the call in `[void] (...)` to keep that boolean out of
 * its own stdout contract.
 *
 * The buffer this function marshals is `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`,
 * with `LimitFlags` and `JobMemoryLimit` set inside its embedded
 * `JOBOBJECT_BASIC_LIMIT_INFORMATION`. Both structs contain `SIZE_T` and
 * `ULONG_PTR` fields, which are pointer-sized: 4 bytes in a 32-bit
 * `powershell.exe` process, 8 bytes in a 64-bit one. That changes every
 * field offset after the first one, so every offset below is computed from
 * `[IntPtr]::Size`, the running process's own pointer size, rather than
 * hardcoded. See the inline comments in the script for the field-by-field
 * derivation. On x64, the only architecture this project packages today,
 * this works out to `LimitFlags` at byte 16, `JobMemoryLimit` at byte 120,
 * and a total buffer size of 144 bytes, the numbers the Win32 SDK headers
 * give for this struct on that architecture.
 */
export const WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE = `
Add-Type -Namespace JobMemoryLimit -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
'@

# Rounds $offset up to the next multiple of $alignment. Every pointer-sized
# field (SIZE_T, ULONG_PTR) must start at an address that is itself a
# multiple of the pointer size, and the C compiler inserts padding to make
# that true; this reproduces that padding so the PowerShell buffer matches
# the real struct byte for byte.
function Align([int]$offset, [int]$alignment) {
  $remainder = $offset % $alignment
  if ($remainder -eq 0) { return $offset }
  return $offset + ($alignment - $remainder)
}

function Set-JobMemoryLimit([long]$bytes, [IntPtr]$processHandle) {
  if ($processHandle -eq [IntPtr]::Zero) { return $false }
  $job = [JobMemoryLimit.Native]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { return $false }

  # $ptrSize is 8 in a 64-bit powershell.exe, 4 in a 32-bit one. It governs
  # every SIZE_T and ULONG_PTR field below. A LARGE_INTEGER or ULONGLONG
  # field is always 8 bytes on both, and a DWORD is always 4.
  $ptrSize = [IntPtr]::Size

  # JOBOBJECT_BASIC_LIMIT_INFORMATION, embedded at offset 0:
  #   PerProcessUserTimeLimit  LARGE_INTEGER  offset 0,  size 8
  #   PerJobUserTimeLimit      LARGE_INTEGER  offset 8,  size 8
  #   LimitFlags               DWORD          offset 16  (always 16: two
  #                                            8-byte fields precede it,
  #                                            on every architecture)
  #   MinimumWorkingSetSize    SIZE_T         offset align(20, ptrSize)
  #   MaximumWorkingSetSize    SIZE_T         offset (Minimum + ptrSize)
  #   ActiveProcessLimit       DWORD          offset (Maximum + ptrSize)
  #   Affinity                 ULONG_PTR      offset align(ActiveProcessLimit + 4, ptrSize)
  #   PriorityClass            DWORD          offset (Affinity + ptrSize)
  #   SchedulingClass          DWORD          offset (PriorityClass + 4)
  # The struct's own size is padded to 8, the widest member alignment
  # (LARGE_INTEGER) it contains on either architecture.
  $limitFlagsOffset = 16
  $minimumWorkingSetSizeOffset = Align 20 $ptrSize
  $maximumWorkingSetSizeOffset = $minimumWorkingSetSizeOffset + $ptrSize
  $activeProcessLimitOffset = $maximumWorkingSetSizeOffset + $ptrSize
  $affinityOffset = Align ($activeProcessLimitOffset + 4) $ptrSize
  $priorityClassOffset = $affinityOffset + $ptrSize
  $schedulingClassOffset = $priorityClassOffset + 4
  $basicLimitSize = Align ($schedulingClassOffset + 4) 8

  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION, the whole buffer:
  #   BasicLimitInformation  offset 0,               size $basicLimitSize
  #   IoInfo (IO_COUNTERS)   offset $basicLimitSize,  size 48 (six ULONGLONG
  #                                                     fields, always 8
  #                                                     bytes each, so this
  #                                                     offset is already
  #                                                     8-aligned)
  #   ProcessMemoryLimit     SIZE_T   offset ($basicLimitSize + 48)
  #   JobMemoryLimit         SIZE_T   offset (ProcessMemoryLimit + ptrSize)
  #   PeakProcessMemoryUsed  SIZE_T   offset (JobMemoryLimit + ptrSize)
  #   PeakJobMemoryUsed      SIZE_T   offset (PeakProcessMemoryUsed + ptrSize)
  # On x64 (ptrSize = 8) this computes LimitFlags at 16, JobMemoryLimit at
  # 120, and a total size of 144, exactly the numbers a 64-bit build of the
  # Win32 SDK headers gives for this struct.
  $ioInfoOffset = $basicLimitSize
  $processMemoryLimitOffset = $ioInfoOffset + 48
  $jobMemoryLimitOffset = $processMemoryLimitOffset + $ptrSize
  $peakProcessMemoryUsedOffset = $jobMemoryLimitOffset + $ptrSize
  $peakJobMemoryUsedOffset = $peakProcessMemoryUsedOffset + $ptrSize
  $size = Align ($peakJobMemoryUsedOffset + $ptrSize) 8

  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    for ($i = 0; $i -lt $size; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
    [System.Runtime.InteropServices.Marshal]::WriteInt32($buf, $limitFlagsOffset, 0x200)
    # JobMemoryLimit is a SIZE_T; WriteIntPtr writes exactly $ptrSize bytes,
    # the pointer width of this same process, so this is correct on both
    # architectures without a separate branch on $ptrSize.
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr($buf, $jobMemoryLimitOffset, [IntPtr]$bytes)
    $setOk = [JobMemoryLimit.Native]::SetInformationJobObject($job, 9, $buf, [uint32]$size)
    $assignOk = [JobMemoryLimit.Native]::AssignProcessToJobObject($job, $processHandle)
    return ($setOk -and $assignOk)
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

/**
 * The exact text a caller's script prints to stdout after `Set-JobMemoryLimit`
 * returns `$true`, and the only text `server/image-normalize-memory-bound.ts`
 * accepts as proof the limit was installed. Anything else on stdout,
 * including nothing at all, means the limit is not installed, whether
 * because `powershell.exe` could not be found, the script failed for some
 * other reason, or the Job Object calls themselves returned false.
 */
export const WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER = "JOB_MEMORY_LIMIT_INSTALLED";
