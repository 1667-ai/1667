import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { resolveMachineTierRoot } from "../server/machine-tier.js";

const execFileAsync = promisify(execFile);

test("Windows machine tier rejects a hard link without changing its source", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-hard-link-");
  const root = path.join(parent, "state");
  const outside = path.join(parent, "outside.json");
  const linked = path.join(root, "linked.json");
  await writeFile(outside, "outside");
  await grantEveryone(outside);
  const before = await readSecurity(outside);
  assert.equal(await resolveMachineTierRoot({ override: root }), root);
  await link(outside, linked);

  await assert.rejects(
    resolveMachineTierRoot({ override: root }),
    /multiple hard links/
  );
  assert.deepEqual(await readSecurity(outside), before);
});

test("Windows machine tier repairs a null DACL", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-null-dacl-");
  const root = path.join(parent, "state");
  const child = path.join(root, "http");
  assert.equal(await resolveMachineTierRoot({ override: root }), root);
  await mkdir(child);
  await setNullDacl(child);

  assert.equal(await resolveMachineTierRoot({ override: root }), root);
  await assertPrivateSecurity(child);
});

interface SecuritySnapshot {
  readonly protected: boolean;
  readonly owner: string;
  readonly user: string;
  readonly rules: readonly {
    readonly sid: string;
    readonly inherited: boolean;
    readonly type: string;
    readonly rights: number;
    readonly inheritance: number;
    readonly propagation: number;
  }[];
}

async function assertPrivateSecurity(directory: string): Promise<void> {
  const security = await readSecurity(directory);
  assert.equal(security.protected, true);
  assert.equal(security.owner, security.user);
  assert.deepEqual(
    security.rules.map((rule) => rule.sid).sort(),
    [security.user, "S-1-5-18"].sort()
  );
  for (const rule of security.rules) {
    assert.equal(rule.inherited, false);
    assert.equal(rule.type, "Allow");
    assert.equal(rule.rights, 0x001f01ff);
    assert.equal(rule.inheritance, 3);
    assert.equal(rule.propagation, 0);
  }
}

async function readSecurity(target: string): Promise<SecuritySnapshot> {
  const script = String.raw`
$sections = (
  [Security.AccessControl.AccessControlSections]::Owner
) -bor [Security.AccessControl.AccessControlSections]::Access
$acl = if ([IO.Directory]::Exists($env:AI_1667_TEST_WINDOWS_PATH)) {
  [IO.Directory]::GetAccessControl($env:AI_1667_TEST_WINDOWS_PATH, $sections)
} else {
  [IO.File]::GetAccessControl($env:AI_1667_TEST_WINDOWS_PATH, $sections)
}
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
) | ForEach-Object {
  [PSCustomObject]@{
    sid = $_.IdentityReference.Value
    inherited = $_.IsInherited
    type = $_.AccessControlType.ToString()
    rights = [int]$_.FileSystemRights
    inheritance = [int]$_.InheritanceFlags
    propagation = [int]$_.PropagationFlags
  }
})
[PSCustomObject]@{
  protected = $acl.AreAccessRulesProtected
  owner = $acl.GetOwner(
    [Security.Principal.SecurityIdentifier]
  ).Value
  user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;
  return JSON.parse(await runPowerShell(script, target)) as SecuritySnapshot;
}

async function grantEveryone(target: string): Promise<void> {
  const script = String.raw`
$acl = [IO.File]::GetAccessControl($env:AI_1667_TEST_WINDOWS_PATH)
$everyone = New-Object Security.Principal.SecurityIdentifier("S-1-1-0")
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $everyone,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($env:AI_1667_TEST_WINDOWS_PATH, $acl)
`;
  await runPowerShell(script, target);
}

async function setNullDacl(target: string): Promise<void> {
  const script = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WindowsAclEdgeCase {
  [DllImport(
    "advapi32.dll",
    CharSet = CharSet.Unicode,
    EntryPoint = "SetNamedSecurityInfoW"
  )]
  public static extern uint SetNamedSecurityInfo(
    string name,
    int type,
    uint info,
    IntPtr owner,
    IntPtr group,
    IntPtr dacl,
    IntPtr sacl
  );
}
"@
$result = [WindowsAclEdgeCase]::SetNamedSecurityInfo(
  $env:AI_1667_TEST_WINDOWS_PATH,
  1,
  4,
  [IntPtr]::Zero,
  [IntPtr]::Zero,
  [IntPtr]::Zero,
  [IntPtr]::Zero
)
if ($result -ne 0) {
  throw "SetNamedSecurityInfo failed with Windows error $result"
}
`;
  await runPowerShell(script, target);
}

async function runPowerShell(
  script: string,
  target: string
): Promise<string> {
  const executable = path.join(
    process.env.SystemRoot!,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const encoded = Buffer.from(
    '$ErrorActionPreference = "Stop"\n' + script,
    "utf16le"
  ).toString("base64");
  const { stdout } = await execFileAsync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        AI_1667_TEST_WINDOWS_PATH: target
      },
      windowsHide: true
    }
  );
  return stdout.trim();
}

async function temporaryDirectory(
  t: TestContext,
  prefix: string
): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}
