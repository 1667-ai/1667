import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";

const execFileAsync = promisify(execFile);
const ROOT_VARIABLE = "AI_1667_WINDOWS_STATE_ROOT_INTERNAL";
const BASE_VARIABLE = "AI_1667_WINDOWS_STATE_BASE_INTERNAL";

const LOCAL_APP_DATA_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directory = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData
)
if ([String]::IsNullOrWhiteSpace($directory)) {
  throw "Windows did not return LocalAppData"
}
[Console]::Out.Write($directory)
`;

const PREPARE_PRIVATE_ROOT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$root = [Environment]::GetEnvironmentVariable(
  "AI_1667_WINDOWS_STATE_ROOT_INTERNAL"
)
$base = [Environment]::GetEnvironmentVariable(
  "AI_1667_WINDOWS_STATE_BASE_INTERNAL"
)
if ([String]::IsNullOrWhiteSpace($root)) {
  throw "Windows private state root is absent"
}

$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$inherit = (
  [Security.AccessControl.InheritanceFlags]::ContainerInherit
) -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$full = [Security.AccessControl.FileSystemRights]::FullControl

function Protect-1667Directory([string]$candidate) {
  if ([IO.File]::Exists($candidate)) {
    throw "Windows private state path is not a directory: $candidate"
  }
  [void][IO.Directory]::CreateDirectory($candidate)
  $before = Get-Item -LiteralPath $candidate -Force
  if ((-not $before.PSIsContainer) -or (
    $before.Attributes -band [IO.FileAttributes]::ReparsePoint
  ) -ne 0) {
    throw "Windows private state path is a reparse point: $candidate"
  }

  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  [void]$security.AddAccessRule(
    (New-Object Security.AccessControl.FileSystemAccessRule(
      $user, $full, $inherit, $propagation, $allow
    ))
  )
  [void]$security.AddAccessRule(
    (New-Object Security.AccessControl.FileSystemAccessRule(
      $system, $full, $inherit, $propagation, $allow
    ))
  )
  [IO.Directory]::SetAccessControl($candidate, $security)

  $after = Get-Item -LiteralPath $candidate -Force
  if ((-not $after.PSIsContainer) -or (
    $after.Attributes -band [IO.FileAttributes]::ReparsePoint
  ) -ne 0) {
    throw "Windows private state path changed during DACL preparation: $candidate"
  }
  $actual = [IO.Directory]::GetAccessControl(
    $candidate,
    (
      [Security.AccessControl.AccessControlSections]::Owner
    ) -bor [Security.AccessControl.AccessControlSections]::Access
  )
  if ((-not $actual.AreAccessRulesProtected) -or (-not $actual.GetOwner(
      [Security.Principal.SecurityIdentifier]
    ).Equals($user))) {
    throw "Windows private state DACL is not protected: $candidate"
  }
  $rules = @($actual.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne 2) {
    throw "Windows private state DACL has unexpected entries: $candidate"
  }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    $unsafe = $sid -ne $user.Value -and $sid -ne $system.Value
    $unsafe = $unsafe -or $seen.ContainsKey($sid)
    $unsafe = $unsafe -or $rule.IsInherited
    $unsafe = $unsafe -or $rule.AccessControlType -ne $allow
    $unsafe = $unsafe -or $rule.FileSystemRights -ne $full
    $unsafe = $unsafe -or $rule.InheritanceFlags -ne $inherit
    $unsafe = $unsafe -or $rule.PropagationFlags -ne $propagation
    if ($unsafe) {
      throw "Windows private state DACL is unsafe: $candidate"
    }
    $seen[$sid] = $true
  }
}

if ([String]::IsNullOrWhiteSpace($base)) {
  Protect-1667Directory $root
} else {
  $separator = [IO.Path]::DirectorySeparatorChar
  $prefix = $base.TrimEnd($separator) + $separator
  if (-not $root.StartsWith(
    $prefix,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Windows private state root is outside its trusted base"
  }
  $cursor = $base.TrimEnd($separator)
  $relative = $root.Substring($prefix.Length)
  foreach ($component in $relative.Split($separator)) {
    $invalid = [String]::IsNullOrWhiteSpace($component)
    $invalid = $invalid -or $component -eq "."
    $invalid = $invalid -or $component -eq ".."
    if ($invalid) {
      throw "Windows private state root has an invalid component"
    }
    $cursor = [IO.Path]::Combine($cursor, $component)
    Protect-1667Directory $cursor
  }
}
[Console]::Out.Write($root)
`;

export function createNodeWindowsPrivateStateRootAdapter(): WindowsPrivateStateRootAdapter {
  return {
    localAppDataDirectory: async () => {
      const observed = await runPowerShell(LOCAL_APP_DATA_SCRIPT);
      return await realpath(observed);
    },
    preparePrivateStateRoot: async (root, trustedBase) => {
      const prepared = await runPowerShell(PREPARE_PRIVATE_ROOT_SCRIPT, {
        [ROOT_VARIABLE]: root,
        ...(trustedBase === undefined ? {} : { [BASE_VARIABLE]: trustedBase })
      });
      return prepared;
    }
  };
}

async function runPowerShell(
  script: string,
  additions: Readonly<Record<string, string>> = {}
): Promise<string> {
  const systemRoot = trustedSystemRoot(process.env);
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      env: windowsSystemEnvironment(process.env, systemRoot, additions),
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      windowsHide: true
    }
  );
  const result = stdout.trim();
  if (result === "") throw new Error("Windows private state adapter returned no path");
  return result;
}

function trustedSystemRoot(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot;
  const windir = environment.WINDIR;
  if (systemRoot === undefined
    || windir === undefined
    || systemRoot.toLowerCase() !== windir.toLowerCase()
    || !path.win32.isAbsolute(systemRoot)
    || path.win32.normalize(systemRoot) !== systemRoot
    || path.win32.parse(systemRoot).root === systemRoot) {
    throw new Error("Windows SystemRoot is unavailable or ambiguous");
  }
  return systemRoot;
}

function windowsSystemEnvironment(
  source: NodeJS.ProcessEnv,
  systemRoot: string,
  additions: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ["COMSPEC", "PATHEXT", "TEMP", "TMP"].flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ...inherited,
    ...additions
  };
}
