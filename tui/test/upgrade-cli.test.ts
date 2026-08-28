import { expect, test } from "bun:test";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_TARGETS,
  releaseTargetForArtifact
} from "../../shared/release-targets.js";
import {
  currentPlatformPackage,
  executeUpgradeCli,
  formatUpgradeApplyCommand,
  parseUpgradeArguments,
  runProcessUpgrade,
  windowsInstallCommand
} from "../src/upgrade-cli.js";
import { UpgradeFailure, type UpgradeChannel } from "../src/upgrade-contract.js";
import type { PlatformPackage, RegistryFetch } from "../src/npm-upgrade-registry.js";
import type { UpgradeObservation, UpgradeRegistry } from "../src/upgrade-plan.js";

const observation: UpgradeObservation = {
  currentVersion: "1.2.3",
  platformPackage: releaseTargetForArtifact("linux-x64").packageName
};

test("the upgrade path offers no package for a target held from publication", () => {
  const published: readonly string[] = PUBLISHED_PLATFORM_PACKAGES;
  for (const descriptor of RELEASE_TARGETS) {
    const offered = currentPlatformPackage(descriptor.platform, descriptor.arch);
    if (descriptor.heldFromPublication === null) {
      expect(offered).toBe(descriptor.packageName);
      expect(published).toContain(descriptor.packageName);
      continue;
    }
    // No package was published, so there is nothing here to check, fetch or
    // verify — and the registry would answer 404 for the attempt.
    expect(offered).toBe(null);
    expect(published).not.toContain(descriptor.packageName);
  }
});

test("upgrade argument parser preserves global version semantics and rejects ambiguity", () => {
  expect(parseUpgradeArguments([
    "--version", "2.0.0-beta.1", "--channel=beta", "--json"
  ])).toEqual({
    command: { kind: "apply", version: "2.0.0-beta.1", channel: "beta" },
    json: true,
    force: false
  });
  expect(parseUpgradeArguments(["--check"])).toEqual({
    command: { kind: "check", channel: "stable" },
    json: false,
    force: false
  });
  expect(parseUpgradeArguments(["--list", "--json"])).toEqual({
    command: { kind: "list" },
    json: true,
    force: false
  });
  expect(parseUpgradeArguments(["--rollback", "--json"])).toEqual({
    command: { kind: "rollback" },
    json: true,
    force: false
  });
  expect(() => parseUpgradeArguments(["--check", "--version", "2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--version", "v2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--channel", "nightly"])).toThrow();
  expect(() => parseUpgradeArguments(["--json", "--json"])).toThrow();
  expect(() => parseUpgradeArguments(["--rollback", "--check"])).toThrow();
  expect(() => parseUpgradeArguments(["--rollback", "--channel", "beta"])).toThrow();
  expect(() => parseUpgradeArguments(["--list", "--channel", "beta"])).toThrow();
  expect(() => parseUpgradeArguments(["--list", "--version", "2.0.0"])).toThrow();
});

test("--force is an apply-time waiver and says so when it would do nothing", () => {
  expect(parseUpgradeArguments(["--force"])).toEqual({
    command: { kind: "apply", version: null, channel: "stable" },
    json: false,
    force: true
  });
  expect(parseUpgradeArguments(["--rollback", "--force"])).toEqual({
    command: { kind: "rollback" },
    json: false,
    force: true
  });
  // A read-only check writes nothing, so the flag would waive nothing there.
  expect(() => parseUpgradeArguments(["--check", "--force"])).toThrow(/--check/u);
  expect(() => parseUpgradeArguments(["--force", "--force"])).toThrow(/only once/u);
});

test("persisted channel is the default and an explicit flag wins", () => {
  expect(parseUpgradeArguments(["--check"], "beta")?.command).toEqual({
    kind: "check",
    channel: "beta"
  });
  expect(parseUpgradeArguments(["--check", "--channel", "stable"], "beta")?.command)
    .toEqual({ kind: "check", channel: "stable" });
});

test("parser never emits impossible command combinations", () => {
  const apply = parseUpgradeArguments(["--version", "1.0.0"]);
  expect(apply?.command).toEqual({
    kind: "apply",
    version: "1.0.0",
    channel: "stable"
  });
  expect(Object.keys(apply!.command).sort()).toEqual(["channel", "kind", "version"]);

  const check = parseUpgradeArguments(["--check"]);
  expect(check?.command).toEqual({ kind: "check", channel: "stable" });
  expect(Object.keys(check!.command).sort()).toEqual(["channel", "kind"]);

  const rollback = parseUpgradeArguments(["--rollback"]);
  expect(rollback?.command).toEqual({ kind: "rollback" });
  expect(Object.keys(rollback!.command)).toEqual(["kind"]);
});

test("typed apply commands have one terminal formatter", () => {
  expect(formatUpgradeApplyCommand({
    kind: "apply",
    channel: "beta",
    version: "2.0.0-beta.1"
  })).toBe("1667 upgrade --version 2.0.0-beta.1 --channel beta");
});

test("JSON success emits exactly one stable envelope and command stays null", async () => {
  const result = await executeUpgradeCli(["--check", "--json"], {
    observation,
    registry: fakeRegistry("1.3.0")
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(result.stdout)).toEqual(result.envelope);
  expect(Object.keys(JSON.parse(result.stdout))).toEqual([
    "status",
    "current",
    "latest",
    "target",
    "channel",
    "method",
    "restartRequired",
    "command",
    "error"
  ]);
  expect(JSON.parse(result.stdout).command).toBe(null);
});

test("--list shows every published release newest first", async () => {
  const calls: string[] = [];
  const versionRegistry = {
    async availableVersions() {
      calls.push("versions");
      return ["2.0.0", "2.0.0-rc.1", "1.2.3"];
    }
  };
  const human = await executeUpgradeCli(["--list"], { versionRegistry });
  expect(human).toMatchObject({
    exitCode: 0,
    stdout: "2.0.0\n2.0.0-rc.1\n1.2.3\n",
    stderr: "",
    envelope: null
  });
  const json = await executeUpgradeCli(["--list", "--json"], { versionRegistry });
  expect(JSON.parse(json.stdout)).toEqual({
    versions: ["2.0.0", "2.0.0-rc.1", "1.2.3"]
  });
  expect(calls).toEqual(["versions", "versions"]);
});

test("--list prints no phantom row when no published release is available", async () => {
  const versionRegistry = { async availableVersions() { return []; } };
  const human = await executeUpgradeCli(["--list"], { versionRegistry });
  expect(human).toMatchObject({ exitCode: 0, stdout: "", stderr: "", envelope: null });
  const json = await executeUpgradeCli(["--list", "--json"], { versionRegistry });
  expect(JSON.parse(json.stdout)).toEqual({ versions: [] });
});

test("JSON usage and operational failures retain the same envelope", async () => {
  const usage = await executeUpgradeCli(["--check", "--version", "2.0.0", "--json"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(usage.exitCode).toBe(2);
  expect(usage.stderr).toBe("");
  expect(JSON.parse(usage.stdout).error.code).toBe("invalid_arguments");
  expect(JSON.parse(usage.stdout).method).toBe("manual");
  expect(JSON.parse(usage.stdout).command).toBe(null);

  const registry = fakeRegistry("2.0.0");
  registry.channelHead = async () => {
    throw new UpgradeFailure("network_error", "Could not check for updates.", true);
  };
  const failure = await executeUpgradeCli(["--json"], { observation, registry });
  expect(failure.exitCode).toBe(1);
  expect(failure.stderr).toBe("");
  expect(JSON.parse(failure.stdout).error).toEqual({
    code: "network_error",
    message: "Could not check for updates.",
    retryable: true,
    details: null
  });
});

test("interruption emits exit 130 and one JSON envelope", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeUpgradeCli(["--check", "--json"], {
    observation,
    registry: fakeRegistry("2.0.0"),
    signal: controller.signal
  });
  expect(result.exitCode).toBe(130);
  expect(JSON.parse(result.stdout).error.code).toBe("interrupted");
  expect(JSON.parse(result.stdout).command).toBe(null);
});

test("rollback refusal keeps its code and reaches JSON without internal names", async () => {
  // failure.message reaches the JSON envelope as well as human stderr, so a
  // wording change is visible to both. The code is the stable machine field.
  const registry = fakeRegistry("2.0.0");
  const json = await executeUpgradeCli(["--rollback", "--json"], { observation, registry });
  expect(json.exitCode).toBe(1);
  const envelope = JSON.parse(json.stdout);
  expect(envelope.status).toBe("error");
  expect(envelope.error.code).toBe("unsupported_target");
  expect(envelope.error.retryable).toBe(false);
  for (const internal of ["Managed Installation", "Shell Installer", "Candidate"]) {
    expect(envelope.error.message).not.toContain(internal);
  }

  const human = await executeUpgradeCli(["--rollback"], { observation, registry });
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toBe("");
  expect(human.stderr).toContain("Rollback works only when you installed 1667");
});

test("human plan output uses only locally derived fixed instructions", async () => {
  const result = await executeUpgradeCli(["--version", "2.0.0"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1667 2.0.0 is available");
  expect(result.stdout).toContain(
    "https://www.npmjs.com/package/@1667-ai/cli/v/2.0.0"
  );
  expect(result.stdout).not.toContain("%2f");
  expect(result.stdout).not.toContain("github");
  expect(result.stdout).toContain("Start 1667 again after you update it.");
  expect(result.stdout).not.toContain("npm install");
  // Output speaks to the person running the command. Internal vocabulary for
  // the install and release model does not tell them what to do.
  for (const internal of [
    "Verified metadata source",
    "Candidate",
    "Managed Installation",
    "trust boundary",
    "Install method"
  ]) {
    expect(result.stdout).not.toContain(internal);
  }
});

test("manual exact downgrade warns about Vault damage and points at that release", async () => {
  const result = await executeUpgradeCli(["--version", "1.0.0"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("make the Vault unreadable or damage Vault data");
  expect(result.stderr).toContain("Back up the Vault before you continue.");
  expect(result.stdout).toContain("1667 1.0.0 is available.");
  expect(result.stdout).toContain("/@1667-ai/cli/v/1.0.0");
  expect(result.stdout).not.toContain("available on stable");
});

test("human checks defer exact instructions until a fresh plan", async () => {
  const result = await executeUpgradeCli(["--check"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(result.stdout).toContain("Run '1667 upgrade'");
  expect(result.stdout).not.toContain("https://");
  expect(result.stdout).not.toContain("Verified metadata source");
});

test("manual current releases do not recommend a redundant reinstall", async () => {
  const result = await executeUpgradeCli([], {
    observation,
    registry: fakeRegistry("1.2.3")
  });
  expect(result.stdout).toContain("is up to date");
  expect(result.stdout).not.toContain("Instructions:");
});

const POWERSHELL_ROOT = "C:\\Users\\writer\\AppData\\Local\\Programs\\1667\\bin";
const NPM_BETA_ATTESTATION = "gh attestation verify .\\install-beta.ps1 --repo 1667-ai/1667 "
  + "--signer-workflow 1667-ai/1667/.github/workflows/release-npm.yml "
  + "--deny-self-hosted-runners";
const LEGACY_BETA_ATTESTATION = "gh attestation verify .\\install-beta.ps1 --repo 1667-ai/1667 "
  + "--signer-workflow 1667-ai/1667/.github/workflows/release-github.yml "
  + "--deny-self-hosted-runners";

function powershellAuthority(channel: "stable" | "beta") {
  return {
    kind: "powershell" as const,
    channel,
    installRoot: POWERSHELL_ROOT,
    executable: `${POWERSHELL_ROOT}\\1667.exe`
  };
}

test("an up-to-date stable PowerShell install prints only its stable state", async () => {
  const result = await executeUpgradeCli([], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry(observation.currentVersion)
  });
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(result.stdout).toBe(
    `1667 ${observation.currentVersion} is up to date on stable.\n`
  );
});

test("PowerShell installs return the rerunnable Windows Installer command", async () => {
  const authority = powershellAuthority("stable");
  const managedCommand = windowsInstallCommand(POWERSHELL_ROOT, "2.0.0");
  const checked = await executeUpgradeCli(["--check", "--json"], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(JSON.parse(checked.stdout)).toMatchObject({
    status: "manual",
    channel: "stable",
    method: "powershell",
    command: managedCommand
  });

  const applied = await executeUpgradeCli([], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.stdout).toContain("1667 2.0.0 is available on stable.");
  expect(applied.stdout).toContain("A Windows PowerShell installation updates through the PowerShell Installer.");
  expect(applied.stdout).toContain("To install it, run:");
  expect(applied.stdout).toContain(managedCommand);
  expect(applied.stdout).not.toContain("1667 did not install this copy");
  expect(applied.stdout).not.toContain("Exit 1667");
  expect(applied.stdout).not.toContain("npmjs.com");

  const rollback = await executeUpgradeCli(["--rollback"], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(rollback.exitCode).toBe(1);
  expect(rollback.stderr).toContain(windowsInstallCommand(POWERSHELL_ROOT));
});

test("an exact stable PowerShell version explains that the saved channel stays stable", async () => {
  const applied = await executeUpgradeCli(["--version", "2.0.0"], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.exitCode).toBe(0);
  expect(applied.stdout).toContain("1667 2.0.0 is available.");
  expect(applied.stdout).toContain("Selecting an exact version does not change your saved channel.");
  expect(applied.stdout).toContain("To install it, run:");
  expect(applied.stdout).toContain(windowsInstallCommand(POWERSHELL_ROOT, "2.0.0"));
  expect(applied.stdout).not.toContain("1667 did not install this copy");
  expect(applied.stdout).not.toContain("Exit 1667");
});

test("PowerShell plans bind the command to the exact immutable stable Installer", async () => {
  const installRoot = "C:\\Writer's $tools";
  const applied = await executeUpgradeCli(["--version", "2.0.0", "--json"], {
    observation,
    authority: {
      ...powershellAuthority("stable"),
      installRoot,
      executable: `${installRoot}\\1667.exe`
    },
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.exitCode).toBe(0);
  const command = JSON.parse(applied.stdout).command as string;
  const encoded = command.split(" ").at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  expect(script).toContain(
    "irm https://github.com/1667-ai/1667/releases/download/v2.0.0/install-stable.ps1"
  );
  expect(script).toContain("-InstallRoot 'C:\\Writer''s $tools'");
  expect(script).not.toContain("https://1667.ai/install.ps1");
});

test("an exact version on beta requires an attested beta Installer", async () => {
  const applied = await executeUpgradeCli([
    "--version",
    "1.0.0",
    "--channel",
    "stable",
    "--json"
  ], {
    observation,
    authority: powershellAuthority("beta"),
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.exitCode).toBe(1);
  expect(applied.stderr).toContain("make the Vault unreadable or damage Vault data");
  const envelope = JSON.parse(applied.stdout);
  expect(envelope).toMatchObject({
    status: "error",
    current: "1.2.3",
    latest: null,
    target: null,
    channel: "stable",
    method: "powershell",
    command: null,
    error: { code: "unsupported_target" }
  });
  expect(envelope.error.message).toContain(
    "https://github.com/1667-ai/1667/releases/download/v1.0.0/install-beta.ps1"
  );
  expect(envelope.error.message).toContain(NPM_BETA_ATTESTATION);
  expect(envelope.error.message).toContain(LEGACY_BETA_ATTESTATION);
  expect(envelope.error.message).not.toContain("EncodedCommand");
});

test("an exact current PowerShell version does not install the channel head", async () => {
  const applied = await executeUpgradeCli([
    "--version",
    observation.currentVersion,
    "--channel",
    "stable",
    "--json"
  ], {
    observation,
    authority: powershellAuthority("beta"),
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.exitCode).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({
    status: "up-to-date",
    current: observation.currentVersion,
    target: null,
    channel: "stable",
    method: "powershell",
    command: null
  });
});

test("PowerShell reruns preserve custom roots and explicit channel switches", async () => {
  const encoded = windowsInstallCommand("C:\\Writer's $tools", "2.0.0")
    .split(" ").at(-1)!;
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(
    "-InstallRoot 'C:\\Writer''s $tools'"
  );
  const switched = await executeUpgradeCli(["--channel", "stable", "--json"], {
    observation,
    authority: powershellAuthority("beta"),
    registry: fakeRegistry(observation.currentVersion)
  });
  expect(switched.exitCode).toBe(0);
  expect(JSON.parse(switched.stdout)).toMatchObject({
    status: "manual",
    current: observation.currentVersion,
    latest: observation.currentVersion,
    target: observation.currentVersion,
    channel: "stable",
    method: "powershell",
    command: windowsInstallCommand(POWERSHELL_ROOT, observation.currentVersion)
  });
});

test("checking beta on PowerShell reports the newer beta without an executable command", async () => {
  const checked = await executeUpgradeCli(["--check", "--channel", "beta", "--json"], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0-beta.1")
  });
  expect(checked.exitCode).toBe(0);
  expect(checked.stderr).toBe("");
  const envelope = JSON.parse(checked.stdout);
  expect(envelope).toMatchObject({
    status: "available",
    current: observation.currentVersion,
    latest: "2.0.0-beta.1",
    target: "2.0.0-beta.1",
    channel: "beta",
    method: "powershell",
    command: null
  });
  expect(checked.stdout).not.toContain("powershell -NoLogo");

  const human = await executeUpgradeCli(["--check", "--channel", "beta"], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0-beta.1")
  });
  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe("");
  expect(human.stdout).toContain("1667 2.0.0-beta.1 is available on beta.");
  expect(human.stdout).toContain("Run '1667 upgrade --channel beta'");
});

test("selecting beta without an exact version stays safe and gives release guidance", async () => {
  const requested = await executeUpgradeCli(["--channel", "beta"], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0-beta.1")
  });
  expect(requested.exitCode).toBe(1);
  expect(requested.stdout).toBe("");
  expect(requested.stderr).toMatch(/Windows .*Installer.*stable.*only/i);
  expect(requested.stderr).toContain("2.0.0-beta.1");
  expect(requested.stderr).toMatch(/download .*Installer/i);
  expect(requested.stderr).toContain(
    "https://github.com/1667-ai/1667/releases/download/v2.0.0-beta.1/install-beta.ps1"
  );
  expect(requested.stderr).toContain(NPM_BETA_ATTESTATION);
  expect(requested.stderr).toContain(LEGACY_BETA_ATTESTATION);
  expect(requested.stderr).toContain(
    "gh release download v2.0.0-beta.1 --repo 1667-ai/1667 "
      + "--pattern install-beta.ps1 --output .\\install-beta.ps1"
  );
  expect(requested.stderr).toMatch(/saved channel.*beta/i);
  expect(requested.stderr).toMatch(/powershell\b.*-File\b.*install-beta\.ps1/i);
  expect(requested.stderr).not.toContain("install-stable.ps1");
  expect(requested.stderr).not.toContain("https://1667.ai/install.ps1");
  expect(requested.stderr).toContain("powershell -NoLogo -NoProfile -ExecutionPolicy Bypass");
  expect(requested.stderr).not.toContain("EncodedCommand");
  expect(/\birm\b.*install-beta\.ps1/i.test(requested.stderr)).toBe(false);
});

test("an exact PowerShell prerelease gives attested beta release guidance", async () => {
  const version = "2.0.0-rc.1";
  const applied = await executeUpgradeCli(["--version", version], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0")
  });
  const output = applied.stdout + applied.stderr;
  expect(applied.exitCode).toBe(1);
  expect(applied.stdout).toBe("");
  expect(output).toContain(version);
  expect(output).toMatch(/download .*Installer/i);
  expect(output).toContain(
    "https://github.com/1667-ai/1667/releases/download/v2.0.0-rc.1/install-beta.ps1"
  );
  expect(output).toContain(NPM_BETA_ATTESTATION);
  expect(output).toContain(LEGACY_BETA_ATTESTATION);
  expect(output).toContain(
    "gh release download v2.0.0-rc.1 --repo 1667-ai/1667 "
      + "--pattern install-beta.ps1 --output .\\install-beta.ps1"
  );
  expect(output).toMatch(/saved channel.*beta/i);
  expect(output).toMatch(/powershell\b.*-File\b.*install-beta\.ps1/i);
  expect(output).toContain("powershell -NoLogo -NoProfile -ExecutionPolicy Bypass");
  expect(output).not.toContain("EncodedCommand");
  expect(/\birm\b.*install-beta\.ps1/i.test(output)).toBe(false);
  expect(output).not.toContain("install-stable.ps1");
  expect(() => windowsInstallCommand(POWERSHELL_ROOT, version)).toThrow(
    /stable channel/
  );
});

test("beta PowerShell rollback states the refusal before reinstall guidance", async () => {
  const rollback = await executeUpgradeCli(["--rollback"], {
    observation,
    authority: powershellAuthority("beta"),
    registry: fakeRegistry("2.0.0-beta.1")
  });
  expect(rollback.exitCode).toBe(1);
  expect(rollback.stdout).toBe("");
  expect(rollback.stderr).toContain("Windows rollback is unavailable.");
  expect(rollback.stderr).toContain(NPM_BETA_ATTESTATION);
  expect(rollback.stderr).toContain("install-beta.ps1");
});

// A beta Installation that is already current is offered no command, so there
// is no installer route to reject.
test("an up-to-date beta PowerShell install still reports its state", async () => {
  const current = await executeUpgradeCli(["--check", "--json"], {
    observation,
    authority: powershellAuthority("beta"),
    registry: fakeRegistry(observation.currentVersion)
  });
  expect(current.exitCode).toBe(0);
  expect(JSON.parse(current.stdout)).toMatchObject({
    status: "up-to-date",
    channel: "beta",
    method: "powershell",
    command: null
  });
});

test("help is local and performs no registry I/O", async () => {
  const registry = fakeRegistry("2.0.0");
  const result = await executeUpgradeCli(["--help"], { observation, registry });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--rollback");
  expect(result.stdout).toContain("--version selects one exact published release");
  expect(result.stdout).toContain("make the Vault unreadable or damage Vault data");
  // Help speaks to the person running the command. Internal names for the
  // install model do not tell them what to do. Assert the whole sentence: a
  // substring still passes if the guidance loses a case or is reversed.
  expect(result.stdout).toContain(
    "If you installed 1667 with npm, or you built it from source, update it the same\nway you installed it."
  );
  for (const internal of ["Managed Installation", "Candidate", "External installation"]) {
    expect(result.stdout).not.toContain(internal);
  }
  expect(registry.calls).toEqual([]);
});

test("runProcessUpgrade lifecycle maps SIGINT to 130 and SIGTERM to 143", async () => {
  async function withSignal(
    signal: "SIGINT" | "SIGTERM",
    expectedExit: 130 | 143
  ): Promise<void> {
    const previous = new Set(process.listeners(signal));
    const previousExit = process.exitCode;
    const writes: string[] = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const fetcher: RegistryFetch = (_input, init) => new Promise((_resolve, reject) => {
        const abortSignal = init.signal as AbortSignal | undefined;
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
      const running = runProcessUpgrade(["--check", "--json"], fetcher);
      // Allow once() handlers to register.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const handler = process.listeners(signal).find((candidate) => !previous.has(candidate));
      expect(handler).toBeDefined();
      handler!(signal);
      await running;
      expect(process.exitCode).toBe(expectedExit);
      expect(process.listeners(signal).filter((candidate) => !previous.has(candidate))).toEqual([]);
      const payload = writes.join("");
      expect(payload).toContain("\"code\":\"interrupted\"");
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      // Bun treats a leftover non-zero process.exitCode as the suite exit status.
      process.exitCode = previousExit ?? 0;
    }
  }
  await withSignal("SIGINT", 130);
  await withSignal("SIGTERM", 143);
});

function fakeRegistry(head: string): UpgradeRegistry & { calls: string[] } {
  const calls: string[] = [];
  const integrity = `sha512-${"A".repeat(86)}==`;
  return {
    calls,
    async channelHead(channel: UpgradeChannel) {
      calls.push(`tags:${channel}`);
      return head;
    },
    async launcher(version: string) {
      calls.push(`launcher:${version}`);
      return {
        name: "@1667-ai/cli",
        version,
        integrity,
        tarball: `https://registry.npmjs.org/@1667-ai/cli/-/cli-${version}.tgz`
      };
    },
    async platform(packageName: PlatformPackage, version: string) {
      calls.push(`platform:${packageName}:${version}`);
      return {
        name: packageName,
        version,
        integrity,
        tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`
      };
    }
  };
}
