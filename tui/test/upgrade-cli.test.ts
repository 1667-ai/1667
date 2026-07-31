import { expect, test } from "bun:test";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_TARGETS,
  releaseTargetForArtifact
} from "../../shared/release-targets.js";
import {
  currentPlatformPackage,
  executeUpgradeCli,
  parseUpgradeArguments,
  runProcessUpgrade,
  WINDOWS_INSTALL_COMMAND
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
    json: true
  });
  expect(parseUpgradeArguments(["--check"])).toEqual({
    command: { kind: "check", channel: "stable" },
    json: false
  });
  expect(parseUpgradeArguments(["--rollback", "--json"])).toEqual({
    command: { kind: "rollback" },
    json: true
  });
  expect(() => parseUpgradeArguments(["--check", "--version", "2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--version", "v2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--channel", "nightly"])).toThrow();
  expect(() => parseUpgradeArguments(["--json", "--json"])).toThrow();
  expect(() => parseUpgradeArguments(["--rollback", "--check"])).toThrow();
  expect(() => parseUpgradeArguments(["--rollback", "--channel", "beta"])).toThrow();
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
  expect(result.stdout).toContain("outside 1667's trust boundary");
  expect(result.stdout).not.toContain("npm install");
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

function powershellAuthority(channel: "stable" | "beta") {
  return {
    kind: "powershell" as const,
    channel,
    installRoot: POWERSHELL_ROOT,
    executable: `${POWERSHELL_ROOT}\\1667.exe`
  };
}

test("PowerShell installs return the rerunnable Windows Installer command", async () => {
  const authority = powershellAuthority("stable");
  const checked = await executeUpgradeCli(["--check", "--json"], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(JSON.parse(checked.stdout)).toMatchObject({
    status: "manual",
    channel: "stable",
    method: "powershell",
    command: WINDOWS_INSTALL_COMMAND
  });

  const applied = await executeUpgradeCli([], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(applied.stdout).toContain("Exit 1667, then run:");
  expect(applied.stdout).toContain(WINDOWS_INSTALL_COMMAND);
  expect(applied.stdout).not.toContain("npmjs.com");

  const rollback = await executeUpgradeCli(["--rollback"], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(rollback.exitCode).toBe(1);
  expect(rollback.stderr).toContain(WINDOWS_INSTALL_COMMAND);
});

// https://1667.ai/install.ps1 serves the one promoted release. Handing it to a
// beta Installation would verify a beta version and then install the stable
// one, rewriting the Ownership Record to the wrong channel.
test("a channel the Windows Installer route cannot serve is refused", async () => {
  const authority = powershellAuthority("beta");
  const checked = await executeUpgradeCli(["--check", "--json"], {
    observation,
    authority,
    registry: fakeRegistry("2.0.0")
  });
  expect(checked.exitCode).toBe(1);
  const envelope = JSON.parse(checked.stdout);
  expect(envelope.status).toBe("error");
  expect(envelope.error.code).toBe("unsupported_target");
  expect(envelope.error.message).toContain("install-beta.ps1");
  expect(checked.stdout).not.toContain(WINDOWS_INSTALL_COMMAND);

  const requested = await executeUpgradeCli(["--channel", "beta"], {
    observation,
    authority: powershellAuthority("stable"),
    registry: fakeRegistry("2.0.0")
  });
  expect(requested.exitCode).toBe(1);
  expect(requested.stderr).toContain("install-beta.ps1");
  expect(requested.stderr).not.toContain(WINDOWS_INSTALL_COMMAND);
});

test("help is local and performs no registry I/O", async () => {
  const registry = fakeRegistry("2.0.0");
  const result = await executeUpgradeCli(["--help"], { observation, registry });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Managed Installations apply a verified Candidate");
  expect(result.stdout).toContain("--rollback");
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
