import { INSTALL_OWNERSHIP_FILE } from "../../shared/install-ownership-record.js";
import { INSTALL_LOCK_FILE } from "../../shared/install-layout.js";
import { WINDOWS_UPGRADE_FAILURE_FILE } from "./windows-upgrade-state.js";

export const HANDOFF_SCRIPT = "handoff.ps1" as const;
export const HANDOFF_REQUEST = "request.json" as const;
export const WINDOWS_HANDOFF_BODY = String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OwnershipName = '${INSTALL_OWNERSHIP_FILE}'
$LockName = '${INSTALL_LOCK_FILE}'
$RequestName = '${HANDOFF_REQUEST}'
$TransactionName = 'transaction.json'
$ErrorName = 'error.txt'
$FailureName = '${WINDOWS_UPGRADE_FAILURE_FILE}'
$ArtifactTarget = 'windows-x64'
$WorkRoot = [IO.Path]::GetFullPath((Get-Location).ProviderPath).TrimEnd('\')

function Fail([string]$Message) { throw "1667 upgrade: $Message" }

function Read-Request {
  $requestPath = [IO.Path]::Combine($WorkRoot, $RequestName)
  $item = Get-Item -LiteralPath $requestPath -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 16384) {
    Fail 'Upgrade handoff request is invalid.'
  }
  try { $request = [IO.File]::ReadAllText($requestPath) | ConvertFrom-Json }
  catch { Fail 'Upgrade handoff request is invalid.' }
  $names = @($request.PSObject.Properties.Name | Sort-Object)
  $expected = @('candidate','candidateSha256','currentVersion','executable','expectedChannel','installationId','installRoot','targetChannel','targetVersion','updateChannel')
  if (($names -join ',') -cne ($expected -join ',') -or
      $request.installRoot -isnot [string] -or $request.executable -isnot [string] -or
      $request.installationId -isnot [string] -or
      $request.installationId -cnotmatch '^[0-9a-f]{32}$' -or
      $request.expectedChannel -notin @('stable','beta') -or
      $request.targetChannel -notin @('stable','beta') -or
      $request.updateChannel -isnot [bool] -or $request.candidate -isnot [string] -or
      $request.candidateSha256 -isnot [string] -or
      $request.candidateSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $request.currentVersion -isnot [string] -or $request.targetVersion -isnot [string]) {
    Fail 'Upgrade handoff request is invalid.'
  }
  return $request
}

function Assert-NoReparsePoint([string]$PathValue) {
  $current = [IO.Path]::GetPathRoot($PathValue)
  $relative = $PathValue.Substring($current.Length)
  foreach ($part in $relative.Split(@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) {
      Fail "Path is missing: $current"
    }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "Path contains a reparse point: $current"
    }
  }
}

function Read-Ownership([string]$RecordPath) {
  Assert-NoReparsePoint $RecordPath
  $item = Get-Item -LiteralPath $RecordPath -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 16384) {
    Fail 'Ownership Record is invalid.'
  }
  try { $record = [IO.File]::ReadAllText($RecordPath) | ConvertFrom-Json }
  catch { Fail 'Ownership Record is invalid.' }
  $names = @($record.PSObject.Properties.Name | Sort-Object)
  $expected = @('artifactTarget','channel','executable','installationId','installRoot','method','product','schemaVersion')
  if (($names -join ',') -cne ($expected -join ',')) { Fail 'Ownership Record is invalid.' }
  if ($record.schemaVersion -ne 1 -or $record.product -cne '1667' -or
      $record.method -cne 'powershell' -or $record.artifactTarget -cne $ArtifactTarget -or
      ($record.channel -cne 'stable' -and $record.channel -cne 'beta') -or
      $record.installRoot -ine $InstallRoot -or
      $record.executable -ine $Executable -or
      $record.installationId -cne $InstallationId -or
      $record.installationId -cnotmatch '^[0-9a-f]{32}$') {
    Fail 'Ownership Record changed before the upgrade handoff.'
  }
  return $record
}

function Write-TextAtomic([string]$PathValue, [string]$Text, [string]$Temporary) {
  [IO.File]::WriteAllText($Temporary, $Text, (New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists($PathValue)) {
    $backup = "$Temporary.previous"
    [IO.File]::Replace($Temporary, $PathValue, $backup, $true)
    try {
      if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    } catch { }
  } else {
    [IO.File]::Move($Temporary, $PathValue)
  }
}

function Sanitize-FailureMessage([string]$Message) {
  $clean = ($Message -replace '[\x00-\x1F\x7F]+', ' ').Trim()
  $clean = ($clean -replace '^1667 upgrade:\s*', '').Trim()
  if ([String]::IsNullOrWhiteSpace($clean)) { $clean = 'The Windows upgrade helper failed.' }
  if ($clean.Length -gt 512) { $clean = $clean.Substring(0, 512).TrimEnd() }
  return $clean
}

function Write-FailureRecord([string]$ActiveState, [string]$Message) {
  $failure = [ordered]@{
    schemaVersion = 1
    product = '1667'
    installationId = $InstallationId
    workRoot = [IO.Path]::GetFileName($WorkRoot)
    fromVersion = $CurrentVersion
    targetVersion = $TargetVersion
    targetChannel = $TargetChannel
    activeState = $ActiveState
    message = (Sanitize-FailureMessage $Message)
  }
  $failurePath = [IO.Path]::Combine($InstallRoot, $FailureName)
  $temporary = [IO.Path]::Combine($WorkRoot, 'failure-record.tmp')
  Write-TextAtomic $failurePath (($failure | ConvertTo-Json -Compress) + [Environment]::NewLine) $temporary
}

function Clear-MatchingFailureRecord([string]$Installation) {
  $failurePath = [IO.Path]::Combine($InstallRoot, $FailureName)
  if (-not [IO.File]::Exists($failurePath)) { return }
  try {
    $item = Get-Item -LiteralPath $failurePath -Force
    if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 4096 -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return }
    $failure = [IO.File]::ReadAllText($failurePath) | ConvertFrom-Json
    $names = @($failure.PSObject.Properties.Name | Sort-Object)
    $expected = @('activeState','fromVersion','installationId','message','product','schemaVersion','targetChannel','targetVersion','workRoot')
    if (($names -join ',') -ceq ($expected -join ',') -and
        $failure.schemaVersion -eq 1 -and $failure.product -ceq '1667' -and
        $failure.installationId -ceq $Installation) {
      [IO.File]::Delete($failurePath)
    }
  } catch { }
}

function Assert-Candidate([string]$PathValue) {
  Assert-NoReparsePoint $PathValue
  $actual = (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $CandidateSha256) { Fail 'Candidate SHA-256 digest changed before handoff.' }
  Assert-ReleaseIdentity $PathValue $TargetVersion 'Candidate'
}

function Read-ReleaseVersion([string]$PathValue, [string]$Label) {
  Assert-NoReparsePoint $PathValue
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $PathValue
  $start.Arguments = '--version --json'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { Fail "$Label version probe did not start." }
  if (-not $process.WaitForExit(5000)) {
    try { $process.Kill() } catch { }
    Fail "$Label version probe timed out."
  }
  $output = $process.StandardOutput.ReadToEnd()
  $errorOutput = $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne 0 -or $output.Length -gt 65536 -or $errorOutput.Length -gt 65536) {
    Fail "$Label version probe failed."
  }
  try { $identity = $output | ConvertFrom-Json }
  catch { Fail "$Label version probe returned invalid JSON." }
  if ($identity.schemaVersion -ne 1 -or $identity.product -cne '1667' -or
      $identity.productVersion -isnot [string] -or
      $identity.artifactTarget -cne $ArtifactTarget -or
      $identity.buildKind -cne 'release' -or $identity.sourceDirty -ne $false) {
    Fail "$Label release identity is invalid."
  }
  return [string]$identity.productVersion
}

function Assert-ReleaseIdentity([string]$PathValue, [string]$Version, [string]$Label) {
  if ((Read-ReleaseVersion $PathValue $Label) -cne $Version) {
    Fail "$Label release identity is invalid."
  }
}

function Open-InstallLock([string]$PathValue) {
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      return [IO.File]::Open($PathValue, [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      $nativeCode = $_.Exception.HResult -band 0xFFFF
      if ($nativeCode -ne 32 -and $nativeCode -ne 33) {
        Fail 'Could not acquire the Install Root lock.'
      }
      if ($deadline.ElapsedMilliseconds -ge 65000) {
        Fail 'Another installer holds the Install Root lock.'
      }
      Start-Sleep -Milliseconds 100
    } catch [UnauthorizedAccessException] {
      Fail 'Could not acquire the Install Root lock.'
    }
  }
}

function Replace-AfterUnlock([string]$CandidatePath, [string]$ActivePath, [string]$BackupPath) {
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      [IO.File]::Replace($CandidatePath, $ActivePath, $BackupPath, $true)
      return
    } catch [IO.IOException] {
      $nativeCode = $_.Exception.HResult -band 0xFFFF
      if ($nativeCode -ne 32 -and $nativeCode -ne 33) {
        Fail "Could not replace 1667.exe: $($_.Exception.Message)"
      }
      if ($deadline.ElapsedMilliseconds -ge 60000) {
        Fail 'Could not replace 1667.exe. Close all running 1667 processes, then run the upgrade command again.'
      }
      Start-Sleep -Milliseconds 100
    } catch [UnauthorizedAccessException] {
      Fail 'Could not replace 1667.exe. Check the file permissions, then run the upgrade command again.'
    }
  }
}

function Main {
  $request = Read-Request
  $InstallRoot = [string]$request.installRoot
  $Executable = [string]$request.executable
  $InstallationId = [string]$request.installationId
  $ExpectedChannel = [string]$request.expectedChannel
  $TargetChannel = [string]$request.targetChannel
  $UpdateChannel = [bool]$request.updateChannel
  $Candidate = [string]$request.candidate
  $CandidateSha256 = [string]$request.candidateSha256
  $CurrentVersion = [string]$request.currentVersion
  $TargetVersion = [string]$request.targetVersion
  $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $active = [IO.Path]::GetFullPath($Executable)
  $work = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
  $candidatePath = [IO.Path]::GetFullPath($Candidate)
  if ($root -notmatch '^[A-Za-z]:\\' -or
      $active -ine [IO.Path]::Combine($root, '1667.exe') -or
      [IO.Path]::GetDirectoryName($work) -ine $root -or
      -not [IO.Path]::GetFileName($work).StartsWith('.1667-upgrade.', [StringComparison]::Ordinal) -or
      $candidatePath -ine [IO.Path]::Combine($work, '1667-candidate.exe')) {
    Fail 'Upgrade handoff paths are invalid.'
  }
  Assert-NoReparsePoint $root
  Assert-NoReparsePoint $work

  $lockPath = [IO.Path]::Combine($root, $LockName)
  $lock = $null
  $replaced = $false
  $failureRecordAuthorized = $false
  $backup = [IO.Path]::Combine($work, '1667-previous.exe')
  $recordPath = [IO.Path]::Combine($root, $OwnershipName)
  $transactionPath = [IO.Path]::Combine($work, $TransactionName)
  try {
    $lock = Open-InstallLock $lockPath
    $record = Read-Ownership $recordPath
    $savedChannel = if ($UpdateChannel) { $TargetChannel } else { $ExpectedChannel }
    $activeVersion = Read-ReleaseVersion $active 'Active executable'
    if ($record.channel -ceq $savedChannel -and $activeVersion -ceq $TargetVersion) {
      try { Clear-MatchingFailureRecord ([string]$record.installationId) } catch { }
    } elseif ($record.channel -ceq $ExpectedChannel -and
        $activeVersion -ceq $CurrentVersion) {
      $failureRecordAuthorized = $true
      Assert-Candidate $candidatePath

      $transaction = [ordered]@{
        schemaVersion = 1
        product = '1667'
        installationId = [string]$record.installationId
        fromVersion = $CurrentVersion
        toVersion = $TargetVersion
        channel = $TargetChannel
        updateChannel = $UpdateChannel
        executable = $active
        candidate = $candidatePath
        phase = 'candidate-ready'
      }
      Write-TextAtomic $transactionPath (($transaction | ConvertTo-Json -Compress) + [Environment]::NewLine) "$transactionPath.tmp"

      Replace-AfterUnlock $candidatePath $active $backup
      $replaced = $true

      $next = [ordered]@{
        schemaVersion = 1
        product = '1667'
        installationId = [string]$record.installationId
        method = 'powershell'
        channel = $savedChannel
        installRoot = $root
        executable = $active
        artifactTarget = $ArtifactTarget
      }
      Write-TextAtomic $recordPath (($next | ConvertTo-Json -Compress) + [Environment]::NewLine) ([IO.Path]::Combine($work, $OwnershipName))
      $replaced = $false
      $failureRecordAuthorized = $false
      try { Clear-MatchingFailureRecord ([string]$record.installationId) } catch { }
      try {
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
      } catch { }
      try {
        if ([IO.File]::Exists($transactionPath)) { [IO.File]::Delete($transactionPath) }
      } catch { }
    } else {
      Fail 'The Windows installation changed before the upgrade handoff.'
    }
  } catch {
    $failureMessage = [string]$_.Exception.Message
    $activeState = 'unchanged'
    if ($replaced) {
      $activeState = 'target-preserved'
      if ([IO.File]::Exists($backup)) {
        try {
          $failed = [IO.Path]::Combine($work, '1667-failed.exe')
          [IO.File]::Replace($backup, $active, $failed, $true)
          $activeState = 'restored'
          if ([IO.File]::Exists($failed)) { [IO.File]::Delete($failed) }
        } catch {
          $failureMessage += " Rollback also failed: $($_.Exception.Message)"
        }
      }
    }
    if ($failureRecordAuthorized) {
      try { Write-FailureRecord $activeState $failureMessage } catch { }
    }
    try {
      [IO.File]::WriteAllText([IO.Path]::Combine($work, $ErrorName),
        ((Sanitize-FailureMessage $failureMessage) + [Environment]::NewLine),
        (New-Object Text.UTF8Encoding($false)))
    } catch { }
    throw $failureMessage
  } finally {
    if ($null -ne $lock) { $lock.Dispose() }
  }

  try {
    Set-Location -LiteralPath $root
    [Environment]::CurrentDirectory = $root
    Remove-Item -LiteralPath $work -Recurse -Force
  } catch { }
}

try {
  Main
} catch {
  try {
    [IO.File]::WriteAllText([IO.Path]::Combine($WorkRoot, $ErrorName),
      ($_.Exception.Message + [Environment]::NewLine),
      (New-Object Text.UTF8Encoding($false)))
  } catch { }
  exit 1
}
`;
export const WINDOWS_HANDOFF_BOOTSTRAP = String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workRoot = [IO.Path]::GetFullPath((Get-Location).ProviderPath).TrimEnd('\')
$powerShell = [IO.Path]::Combine(
  $env:SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
if (-not [IO.File]::Exists($powerShell)) {
  throw 'Windows PowerShell is unavailable.'
}
$bodyPath = [IO.Path]::Combine($workRoot, '${HANDOFF_SCRIPT}')
$escapedBodyPath = $bodyPath.Replace("'", "''")
$launcher = "& ([ScriptBlock]::Create([IO.File]::ReadAllText('$escapedBodyPath')))"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
$arguments = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  $encoded
)
$helper = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $workRoot -WindowStyle Hidden -PassThru
if ($null -eq $helper -or $helper.Id -le 0) {
  throw 'Could not start the Windows upgrade helper.'
}
`;
