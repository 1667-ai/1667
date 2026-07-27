import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  resolveMachineTierRoot
} from "../server/machine-tier.js";
import {
  createWindowsPrivateStateRootAdapter
} from "../server/platform-state-root-windows.js";
import {
  createNodeWindowsPrivateStateRootAdapter
} from "../server/platform-state-root-windows-node.js";

const execFileAsync = promisify(execFile);

test("Windows machine tier repairs a current-user root without WRITE_OWNER", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-state-");
  const root = path.join(parent, "state");
  await mkdir(root);
  await denyOwnerWrite(root);

  assert.equal(await resolveMachineTierRoot({ override: root }), root);

  await assertPrivateSecurity(root);
});

test("Windows machine tier secures each default state path component", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-default-state-");
  await grantInheritedEveryone(parent);
  const product = path.join(parent, "1667");
  const root = path.join(product, "State");
  const adapter = await createWindowsPrivateStateRootAdapter();

  assert.equal(
    await adapter.preparePrivateStateRoot(root, parent),
    root
  );
  await assertPrivateSecurity(product);
  await assertPrivateSecurity(root);
});

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

test("Windows machine tier rejects a junction root", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-junction-");
  const target = path.join(parent, "target");
  const junction = path.join(parent, "state");
  await mkdir(target);
  await symlink(target, junction, "junction");

  await assert.rejects(
    resolveMachineTierRoot({ override: junction }),
    /reparse point/
  );
});

test("Windows machine tier rejects a junction above its root", {
  skip: process.platform !== "win32"
}, async (t) => {
  const parent = await temporaryDirectory(
    t,
    "1667-windows-junction-ancestor-"
  );
  const target = path.join(parent, "target");
  const junction = path.join(parent, "redirect");
  const root = path.join(junction, "state");
  await mkdir(target);
  await symlink(target, junction, "junction");

  await assert.rejects(
    resolveMachineTierRoot({ override: root }),
    /reparse/
  );
  await assert.rejects(access(path.join(target, "state")), /ENOENT/);
});

test("Node Windows adapter stays inside the server startup budget", {
  skip: process.platform !== "win32" || process.versions.bun !== undefined,
  timeout: 10_000
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-node-adapter-");
  const roots = Array.from(
    { length: 4 },
    (_, index) => path.join(parent, `state-${index}`)
  );
  const adapter = createNodeWindowsPrivateStateRootAdapter();

  assert.deepEqual(
    await Promise.all(
      roots.map(async (root) =>
        await adapter.preparePrivateStateRoot(root))
    ),
    roots
  );
});

test("Windows machine tier repairs an existing non-user owner", {
  skip: process.platform !== "win32"
    || (
      process.env.CI !== "true"
      && process.env.AI_1667_TEST_FOREIGN_OWNER !== "1"
    )
}, async (t) => {
  const parent = await temporaryDirectory(t, "1667-windows-owner-");
  const root = path.join(parent, "state");
  await mkdir(root);
  await setRestrictedNonUserOwner(root);
  const before = await readSecurity(root);
  assert.notEqual(before.owner, before.user);

  assert.equal(await resolveMachineTierRoot({ override: root }), root);
  await assertPrivateSecurity(root);
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

async function readSecurity(directory: string): Promise<SecuritySnapshot> {
  const script = String.raw`
$acl = [IO.Directory]::GetAccessControl(
  $env:AI_1667_TEST_WINDOWS_PATH,
  (
    [Security.AccessControl.AccessControlSections]::Owner
  ) -bor [Security.AccessControl.AccessControlSections]::Access
)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
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
  user = $user
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;
  return JSON.parse(await runPowerShell(script, directory)) as SecuritySnapshot;
}

async function grantInheritedEveryone(directory: string): Promise<void> {
  const script = String.raw`
$everyone = New-Object Security.Principal.SecurityIdentifier("S-1-1-0")
$acl = [IO.Directory]::GetAccessControl($env:AI_1667_TEST_WINDOWS_PATH)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $everyone,
  [Security.AccessControl.FileSystemRights]::FullControl,
  (
    [Security.AccessControl.InheritanceFlags]::ContainerInherit
  ) -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:AI_1667_TEST_WINDOWS_PATH, $acl)
`;
  await runPowerShell(script, directory);
}

async function setRestrictedNonUserOwner(
  directory: string
): Promise<void> {
  const script = String.raw`
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$admins = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
$system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$inherit = (
  [Security.AccessControl.InheritanceFlags]::ContainerInherit
) -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($admins)
$acl.SetAccessRuleProtection($true, $false)
[void]$acl.AddAccessRule(
  (New-Object Security.AccessControl.FileSystemAccessRule(
    $user,
    [Security.AccessControl.FileSystemRights]::Modify,
    $inherit,
    $propagation,
    $allow
  ))
)
[void]$acl.AddAccessRule(
  (New-Object Security.AccessControl.FileSystemAccessRule(
    $system,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    $propagation,
    $allow
  ))
)
[IO.Directory]::SetAccessControl($env:AI_1667_TEST_WINDOWS_PATH, $acl)
`;
  await runPowerShell(script, directory);
}

async function denyOwnerWrite(directory: string): Promise<void> {
  const username = process.env.USERNAME;
  if (username === undefined || username === "") {
    throw new Error("Windows test user name is unavailable");
  }
  await runIcacls(directory, ["/setowner", username]);
  await runIcacls(directory, ["/deny", `${username}:(WO)`]);
}

async function runIcacls(
  directory: string,
  args: readonly string[]
): Promise<void> {
  const executable = path.join(
    process.env.SystemRoot!,
    "System32",
    "icacls.exe"
  );
  await execFileAsync(
    executable,
    [directory, ...args],
    {
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR
      },
      windowsHide: true
    }
  );
}

async function runPowerShell(
  script: string,
  directory: string
): Promise<string> {
  const executable = path.join(
    process.env.SystemRoot!,
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
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        AI_1667_TEST_WINDOWS_PATH: directory
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
