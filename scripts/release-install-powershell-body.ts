/** PowerShell Installer body for the native Windows release. */
import {
  MAX_RELEASE_ARTIFACT_GZIP_BYTES,
  MAX_RELEASE_EXECUTABLE_BYTES,
  RELEASE_TRANSFER_CONNECT_TIMEOUT_MS,
  RELEASE_TRANSFER_TOTAL_TIMEOUT_MS
} from "../shared/release-artifact-bounds.js";
import {
  INSTALL_LOCK_FILE,
  INSTALL_RESERVED_FRESH_NAMES,
  INSTALL_WORK_PREFIX
} from "../shared/install-layout.js";
import {
  INSTALL_OWNERSHIP_FILE,
  RECORD_KEYS
} from "../shared/install-ownership-record.js";
import { INSTALL_SCRIPT_CHANNELS } from "./release-install-channels.js";

const CONNECT_TIMEOUT = RELEASE_TRANSFER_CONNECT_TIMEOUT_MS;
const READ_TIMEOUT = RELEASE_TRANSFER_TOTAL_TIMEOUT_MS;

export function powershellInstallerBody(input: {
  readonly version: string;
  readonly channel: string;
  readonly repository: string;
  readonly assetBase: string;
  readonly archive: string;
  readonly digest: string;
  readonly stem: string;
  readonly archiveEntries: readonly string[];
}): string {
  const entries = input.archiveEntries
    .map((entry) => `  '${entry}'`)
    .join(",\n");
  const reserved = INSTALL_RESERVED_FRESH_NAMES
    .map((name) => `'${name}'`)
    .join(", ");
  const recordKeys = [...RECORD_KEYS]
    .sort()
    .map((key) => `'${key}'`)
    .join(",");
  // The generated Installer must accept the record it wrote itself, so the list is the Installer channel list.
  const installChannels = INSTALL_SCRIPT_CHANNELS
    .map((channel) => `'${channel}'`)
    .join(", ");
  return `# 1667 PowerShell Installer - channel ${input.channel}, version ${input.version}
# Generated release asset. Do not edit. Attest before you trust a local copy.
[CmdletBinding()]
param(
  [string]$InstallRoot = $env:AI_1667_INSTALL_ROOT,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProductVersion = '${input.version}'
$InstallChannel = '${input.channel}'
$GitHubRepository = '${input.repository}'
$AssetBase = '${input.assetBase}'
$ArchiveName = '${input.archive}'
$ArchiveDigest = '${input.digest}'
$ArtifactTarget = 'windows-x64'
$ActiveName = '1667.exe'
$OwnershipName = '${INSTALL_OWNERSHIP_FILE}'
$LockName = '${INSTALL_LOCK_FILE}'
$ArchiveStem = '${input.stem}'
$WorkPrefix = '${INSTALL_WORK_PREFIX}'
# A prior attempt that failed after it took the lock leaves these behind. They
# belong to the Installer, so a root that holds only these is still fresh.
$ReservedFreshNames = @(${reserved})
$ReplaceFailureMessage = 'Could not replace 1667.exe. Close all running 1667 processes, then run this installer again.'
$MaxArchiveBytes = ${MAX_RELEASE_ARTIFACT_GZIP_BYTES}
$MaxExecutableBytes = ${MAX_RELEASE_EXECUTABLE_BYTES}
$ConnectTimeoutMs = ${CONNECT_TIMEOUT}
$ReadTimeoutMs = ${READ_TIMEOUT}
$ReadSliceMs = ${CONNECT_TIMEOUT}
$ExpectedArchiveEntries = @(
${entries}
)

function Fail([string]$Message) {
  throw "1667 install: $Message"
}

function Resolve-InstallRoot([string]$Requested) {
  if ([string]::IsNullOrWhiteSpace($Requested)) {
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($local)) { Fail 'Windows LocalAppData is unavailable.' }
    $Requested = [IO.Path]::Combine($local, 'Programs', '1667', 'bin')
  }
  # Require a drive and a separator in the request itself. IsPathRooted accepts
  # the drive-relative 'C:bin', which resolves against per-drive process state,
  # and it accepts '\\bin'. Windows also treats '/' as a separator, so
  # '//server/share' passes a backslash-prefix test and normalizes to a UNC path,
  # which would take the local ACL and locking assumptions and join PATH.
  # IsPathFullyQualified would say this in one call, but Windows PowerShell 5.1
  # runs on .NET Framework, which does not have it.
  if ($Requested -notmatch '^[A-Za-z]:[\\\\/]') {
    Fail 'Install Root must be an absolute path on a local drive.'
  }
  $resolved = [IO.Path]::GetFullPath($Requested).TrimEnd('\\')
  # Normalization can still produce something else, so check the result too.
  if ($resolved -notmatch '^[A-Za-z]:\\\\') {
    Fail 'Install Root must be an absolute path on a local drive.'
  }
  if ($resolved -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\\')) {
    Fail 'Install Root must not be a file-system root.'
  }
  return $resolved
}

function Assert-NoReparsePoint([string]$PathValue, [switch]$AllowMissingLeaf) {
  $current = [IO.Path]::GetPathRoot($PathValue)
  $relative = $PathValue.Substring($current.Length)
  foreach ($part in $relative.Split(@('\\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) {
      if ($AllowMissingLeaf) { continue }
      Fail "Path is missing: $current"
    }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "Path contains a reparse point: $current"
    }
  }
}

function Protect-InstallRoot([string]$Root) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $user) { Fail 'The current Windows user SID is unavailable.' }
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $user, [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $system, [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, $allow)))
  [IO.Directory]::SetAccessControl($Root, $acl)
}

# Path fields compare case-insensitively, because Windows paths are. The rest
# stay case-sensitive. Rerunning the Installer with an equivalently spelled root
# must not make the Installer reject the record it wrote itself.
function Read-InstallRecord([string]$RecordPath, [string]$Root, [string]$Executable) {
  if (-not [IO.File]::Exists($RecordPath)) { return $null }
  Assert-NoReparsePoint $RecordPath
  $item = Get-Item -LiteralPath $RecordPath -Force
  if ($item.Length -le 0 -or $item.Length -gt 16384) { Fail 'Ownership Record is invalid.' }
  try { $record = [IO.File]::ReadAllText($RecordPath) | ConvertFrom-Json }
  catch { Fail 'Ownership Record is invalid.' }
  $names = @($record.PSObject.Properties.Name | Sort-Object)
  $expected = @(${recordKeys})
  if (($names -join ',') -cne (($expected | Sort-Object) -join ',')) { Fail 'Ownership Record is invalid.' }
  if ($record.schemaVersion -ne 1 -or $record.product -cne '1667' -or
      $record.method -cne 'powershell' -or $record.artifactTarget -cne $ArtifactTarget -or
      ($record.channel -cnotin @(${installChannels})) -or
      $record.installRoot -ine $Root -or $record.executable -ine $Executable -or
      $record.installationId -cnotmatch '^[0-9a-f]{32}$') {
    Fail 'Ownership Record does not authorize this Install Root.'
  }
  return $record
}

function Download-Archive([string]$Url, [string]$Destination) {
  $uri = [Uri]$Url
  if ($uri.Scheme -ne 'https' -and
      -not ($uri.Scheme -eq 'http' -and ($uri.Host -eq '127.0.0.1' -or $uri.Host -eq 'localhost'))) {
    Fail 'Release Archive URL is not permitted.'
  }
  $request = [Net.HttpWebRequest]::Create($uri)
  $request.Timeout = $ConnectTimeoutMs
  # One read may not outlast the whole transfer budget. The stopwatch below can
  # only act between reads, so a long per-read timeout would let a stalling
  # server overshoot the cumulative deadline by that timeout. A slice bounds the
  # overshoot to the slice.
  $request.ReadWriteTimeout = [Math]::Min($ReadTimeoutMs, $ReadSliceMs)
  $response = $null
  $inputStream = $null
  $outputStream = $null
  # ReadWriteTimeout bounds one blocking read, not the transfer. A server that
  # sends a byte before each read deadline would otherwise never end the loop.
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  try {
    $response = $request.GetResponse()
    $finalUri = $response.ResponseUri
    if ($finalUri.Scheme -ne 'https' -and
        -not ($finalUri.Scheme -eq 'http' -and
          ($finalUri.Host -eq '127.0.0.1' -or $finalUri.Host -eq 'localhost'))) {
      Fail 'Release Archive redirect is not permitted.'
    }
    if ($response.ContentLength -gt $MaxArchiveBytes) { Fail 'Release Archive is too large.' }
    $inputStream = $response.GetResponseStream()
    $outputStream = New-Object IO.FileStream(
      $Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    $total = 0L
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $count
      if ($total -gt $MaxArchiveBytes) { Fail 'Release Archive is too large.' }
      if ($deadline.ElapsedMilliseconds -gt $ReadTimeoutMs) {
        $request.Abort()
        Fail 'Release Archive download exceeded its time limit.'
      }
      $outputStream.Write($buffer, 0, $count)
    }
    $outputStream.Flush($true)
  } finally {
    $deadline.Stop()
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Get-Sha256([string]$PathValue) {
  $stream = $null
  $algorithm = $null
  try {
    $stream = [IO.File]::Open(
      $PathValue, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $digest = $algorithm.ComputeHash($stream)
    return [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $algorithm) { $algorithm.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Extract-Candidate([string]$ArchivePath, [string]$WorkRoot) {
  $tar = [IO.Path]::Combine($env:SystemRoot, 'System32', 'tar.exe')
  if (-not [IO.File]::Exists($tar)) { Fail 'Windows tar.exe is required.' }
  $listed = @(& $tar -tzf $ArchivePath)
  if ($LASTEXITCODE -ne 0) { Fail 'Could not list the Release Archive.' }
  [string[]]$listed = @($listed | ForEach-Object { ([string]$_).Replace('\\','/') })
  [string[]]$expected = @($ExpectedArchiveEntries)
  [Array]::Sort($listed, [StringComparer]::Ordinal)
  [Array]::Sort($expected, [StringComparer]::Ordinal)
  $newline = [Environment]::NewLine
  if (($listed -join $newline) -cne ($expected -join $newline)) {
    Fail 'Release Archive layout is invalid.'
  }
  & $tar -xzf $ArchivePath -C $WorkRoot
  if ($LASTEXITCODE -ne 0) { Fail 'Could not extract the Release Archive.' }
  $candidate = [IO.Path]::Combine($WorkRoot, $ArchiveStem, $ActiveName)
  Assert-NoReparsePoint $candidate
  $item = Get-Item -LiteralPath $candidate -Force
  if (-not $item.PSIsContainer -and $item.Length -gt 0 -and $item.Length -le $MaxExecutableBytes) {
    return $candidate
  }
  Fail 'Candidate executable is invalid.'
}

function Assert-CandidateIdentity([string]$Candidate) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Candidate
  $start.Arguments = '--version --json'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { Fail 'Candidate version probe did not start.' }
  if (-not $process.WaitForExit(5000)) {
    try { $process.Kill() } catch { }
    Fail 'Candidate version probe timed out.'
  }
  $output = $process.StandardOutput.ReadToEnd()
  $errorOutput = $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne 0 -or $output.Length -gt 65536 -or $errorOutput.Length -gt 65536) {
    Fail 'Candidate version probe failed.'
  }
  try { $identity = $output | ConvertFrom-Json }
  catch { Fail 'Candidate version probe returned invalid JSON.' }
  if ($identity.schemaVersion -ne 1 -or $identity.product -cne '1667' -or
      $identity.productVersion -cne $ProductVersion -or
      $identity.artifactTarget -cne $ArtifactTarget -or
      $identity.buildKind -cne 'release' -or $identity.sourceDirty -ne $false) {
    Fail 'Candidate identity does not match this installer.'
  }
}

function Write-InstallRecord(
  [string]$RecordPath,
  [string]$Root,
  [string]$Executable,
  [string]$InstallationId,
  [string]$WorkRoot
) {
  $record = [ordered]@{
    schemaVersion = 1
    product = '1667'
    installationId = $InstallationId
    method = 'powershell'
    channel = $InstallChannel
    installRoot = $Root
    executable = $Executable
    artifactTarget = $ArtifactTarget
  }
  $temporary = [IO.Path]::Combine($WorkRoot, $OwnershipName)
  [IO.File]::WriteAllText($temporary,
    (($record | ConvertTo-Json -Compress) + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists($RecordPath)) {
    $previous = [IO.Path]::Combine($WorkRoot, ($OwnershipName + '.previous'))
    [IO.File]::Replace($temporary, $RecordPath, $previous, $true)
  } else {
    [IO.File]::Move($temporary, $RecordPath)
  }
}

function Add-UserPath([string]$Root) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if ($null -eq $key) { Fail 'Could not open the user environment registry key.' }
  try {
    $raw = $key.GetValue(
      'Path',
      '',
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $userPath = if ($null -eq $raw) { '' } else { [string]$raw }
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
      $parts = @($userPath.Split(';', [StringSplitOptions]::RemoveEmptyEntries))
    }
    $containsRoot = $parts | Where-Object {
      [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $Root
    }
    if (-not $containsRoot) {
      $key.SetValue(
        'Path',
        (($parts + $Root) -join ';'),
        [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
  } finally {
    $key.Dispose()
  }
  if (-not (($env:Path.Split(';', [StringSplitOptions]::RemoveEmptyEntries)) |
      Where-Object { $_.TrimEnd('\\') -ieq $Root })) {
    $env:Path = "$Root;$env:Path"
  }
}

function Assert-ExecutableReplaceable([string]$Executable) {
  if (-not [IO.File]::Exists($Executable)) { return }
  $probe = $null
  try {
    $probe = [IO.File]::Open($Executable, [IO.FileMode]::Open,
      [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    Fail $ReplaceFailureMessage
  } catch [UnauthorizedAccessException] {
    Fail $ReplaceFailureMessage
  } finally {
    if ($null -ne $probe) { $probe.Dispose() }
  }
}

function Main {
  if ($env:OS -ne 'Windows_NT') { Fail 'install.ps1 supports Windows only.' }
  if (-not [Environment]::Is64BitOperatingSystem -or
      [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64') {
    Fail '1667 requires Windows x64.'
  }
  $root = Resolve-InstallRoot $InstallRoot
  $url = "$AssetBase/$ArchiveName"
  if ($DryRun) {
    Write-Output "dry-run: would install 1667 $ProductVersion ($InstallChannel) for $ArtifactTarget into $root"
    Write-Output "dry-run: archive $url"
    return
  }

  Assert-NoReparsePoint $root -AllowMissingLeaf
  [IO.Directory]::CreateDirectory($root) | Out-Null
  Assert-NoReparsePoint $root
  $active = [IO.Path]::Combine($root, $ActiveName)
  $recordPath = [IO.Path]::Combine($root, $OwnershipName)
  $hasActive = [IO.File]::Exists($active)
  $record = Read-InstallRecord $recordPath $root $active
  if ($hasActive -and $null -eq $record) {
    Fail "Refusing to replace an unmanaged executable at $active."
  }
  if (-not $hasActive -and $null -eq $record) {
    $other = @(Get-ChildItem -LiteralPath $root -Force |
      Where-Object {
        $ReservedFreshNames -notcontains $_.Name -and
        -not $_.Name.StartsWith($WorkPrefix, [StringComparison]::Ordinal)
      })
    if ($other.Count -gt 0) { Fail 'Fresh Install Root is not empty.' }
  }
  Protect-InstallRoot $root

  $lockPath = [IO.Path]::Combine($root, $LockName)
  $lock = $null
  try {
    try {
      $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      Fail 'Another installer holds the Install Root lock.'
    } catch [UnauthorizedAccessException] {
      Fail 'The Install Root lock is not accessible.'
    }
    $record = Read-InstallRecord $recordPath $root $active
    $hasActive = [IO.File]::Exists($active)
    if ($hasActive -and $null -eq $record) {
      Fail "Refusing to replace an unmanaged executable at $active."
    }
    $installationId = if ($null -eq $record) {
      [Guid]::NewGuid().ToString('N')
    } else { [string]$record.installationId }
    $workRoot = [IO.Path]::Combine($root, ($WorkPrefix + [Guid]::NewGuid().ToString('N')))
    [IO.Directory]::CreateDirectory($workRoot) | Out-Null
    try {
      $archivePath = [IO.Path]::Combine($workRoot, $ArchiveName)
      Download-Archive $url $archivePath
      $actual = Get-Sha256 $archivePath
      if ($actual -cne $ArchiveDigest) { Fail 'Release Archive SHA-256 digest did not match.' }
      $candidate = Extract-Candidate $archivePath $workRoot
      Assert-CandidateIdentity $candidate
      Assert-ExecutableReplaceable $active
      $previous = [IO.Path]::Combine($workRoot, '1667.previous.exe')
      if ([IO.File]::Exists($active)) {
        try {
          [IO.File]::Replace($candidate, $active, $previous, $true)
        } catch [IO.IOException] {
          Fail $ReplaceFailureMessage
        } catch [UnauthorizedAccessException] {
          Fail $ReplaceFailureMessage
        }
        Write-InstallRecord $recordPath $root $active $installationId $workRoot
      } elseif ($null -eq $record) {
        Write-InstallRecord $recordPath $root $active $installationId $workRoot
        try {
          [IO.File]::Move($candidate, $active)
        } catch [IO.IOException] {
          try { Remove-Item -LiteralPath $recordPath -Force } catch { }
          Fail 'Could not install 1667.exe. Run this installer again.'
        } catch [UnauthorizedAccessException] {
          try { Remove-Item -LiteralPath $recordPath -Force } catch { }
          Fail 'Could not install 1667.exe. Run this installer again.'
        }
      } else {
        [IO.File]::Move($candidate, $active)
        Write-InstallRecord $recordPath $root $active $installationId $workRoot
      }
      if ($env:AI_1667_SKIP_PATH_UPDATE -ne '1') { Add-UserPath $root }
    } finally {
      if ([IO.Directory]::Exists($workRoot)) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
      }
    }
  } finally {
    if ($null -ne $lock) { $lock.Dispose() }
  }
  Write-Output "Installed 1667 $ProductVersion ($InstallChannel) for $ArtifactTarget to $active"
  Write-Output 'Open a new PowerShell window, then run: 1667'
}

Main
`;
}
