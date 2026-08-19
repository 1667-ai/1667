import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInstallOwnershipRecord,
  serializeInstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import { sha512Integrity } from "../../shared/release-tar-extract.js";
import {
  RELEASE_LICENSE_FILE_DIGESTS
} from "../../shared/release-package-layout.js";
import { createPackageBuildManifest } from "../../shared/package-build-manifest.js";
import { canonicalNpmTarballUrl } from "../../shared/npm-tarball-url.js";
import {
  releaseTargetForArtifact,
  type BuiltArtifactTarget,
  type PublishedPlatformPackage
} from "../../shared/release-targets.js";
import type { InstallationAuthority } from "../src/install-ownership.js";
import { managedInstallPaths } from "../src/install-layout.js";
import type { PlatformPackage } from "../src/npm-upgrade-registry.js";
import type { UpgradeChannel } from "../src/upgrade-contract.js";
import type { UpgradeRegistry } from "../src/upgrade-plan.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Default managed-install integration target and package pin. */
export const MANAGED_TEST_TARGET = "darwin-arm64" as const;
export const MANAGED_TEST_PACKAGE =
  releaseTargetForArtifact(MANAGED_TEST_TARGET).packageName as PublishedPlatformPackage;
export const MANAGED_TEST_CURRENT = "1.0.0";
export const MANAGED_TEST_NEXT = "1.1.0";
export const MANAGED_TEST_OLDER = "0.9.0";

export function releaseIdentityJson(
  version: string,
  target: BuiltArtifactTarget
): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: "1667",
    productVersion: version,
    buildKind: "release",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    sourceDirty: false,
    buildTimestamp: "2026-07-29T00:00:00.000Z",
    artifactTarget: target,
    apiProtocolVersion: 10,
    minClientProtocolVersion: 10,
    maxClientProtocolVersion: 10
  });
}

export function stubExecutableSource(
  version: string,
  target: BuiltArtifactTarget
): string {
  return `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${releaseIdentityJson(version, target)}
EOF
  exit 0
fi
echo "stub ${version}"
exit 0
`;
}

/** Canonical package build-manifest evidence used by managed package fixtures. */
export const FIXTURE_PACKAGE_BUILD_EVIDENCE = Object.freeze({
  productVersion: "0.0.0",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-29T00:00:00.000Z"
});

export function buildCanonicalPlatformPackage(input: {
  readonly packageName: PublishedPlatformPackage;
  readonly version: string;
  readonly target: BuiltArtifactTarget;
  readonly omit?: string;
  readonly badMode?: string;
  readonly noticeBody?: Buffer | string;
  readonly buildManifestBody?: string;
  readonly sourceCommit?: string;
  readonly buildTimestamp?: string;
}): {
  readonly bytes: Buffer;
  readonly integrity: string;
  readonly tarballUrl: string;
  /** Uncompressed size of package/bin/* executable body only. */
  readonly executableBytes: number;
  /** Sum of all regular-file body bytes in the package layout. */
  readonly regularFileBytes: number;
} {
  const descriptor = releaseTargetForArtifact(input.target);
  if (descriptor.packageName !== input.packageName) {
    throw new Error("fixture package name does not match target");
  }
  const license = readFileSync(path.join(repoRoot, "LICENSE"));
  const notice = input.noticeBody ?? readFileSync(path.join(repoRoot, "NOTICE"));
  if (createHash("sha256").update(license).digest("hex")
    !== RELEASE_LICENSE_FILE_DIGESTS.LICENSE.sha256) {
    throw new Error("fixture LICENSE digest drifted from the release pin");
  }
  if (input.noticeBody === undefined
    && createHash("sha256").update(notice).digest("hex")
      !== RELEASE_LICENSE_FILE_DIGESTS.NOTICE.sha256) {
    throw new Error("fixture NOTICE digest drifted from the release pin");
  }
  const packageBuildManifest = input.buildManifestBody ?? JSON.stringify(
    createPackageBuildManifest(
      {
        productVersion: input.version,
        sourceCommit: input.sourceCommit ?? FIXTURE_PACKAGE_BUILD_EVIDENCE.sourceCommit,
        buildTimestamp: input.buildTimestamp ?? FIXTURE_PACKAGE_BUILD_EVIDENCE.buildTimestamp
      },
      input.packageName,
      input.target
    )
  );
  const executable = stubExecutableSource(input.version, input.target);
  const packageJson = JSON.stringify({
    name: input.packageName,
    version: input.version,
    private: false,
    os: [descriptor.platform],
    cpu: [descriptor.arch],
    ...(descriptor.libc === null ? {} : { libc: [descriptor.libc] }),
    files: [
      descriptor.executable,
      "build-manifest.json",
      "sbom.spdx.json",
      "LICENSE",
      "NOTICE"
    ],
    repository: {
      type: "git",
      url: "git+https://github.com/1667-ai/1667.git"
    },
    license: "Apache-2.0",
    publishConfig: { access: "public" }
  });
  const sbom = JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: input.packageName,
    documentNamespace: `https://1667.ai/spdx/${input.packageName}/${input.version}`
  });
  const entries: Array<{ path: string; body: Buffer | string; mode: number }> = [
    { path: "package", body: "", mode: 0o755 },
    { path: "package/bin", body: "", mode: 0o755 },
    { path: "package/package.json", body: packageJson, mode: 0o644 },
    { path: "package/build-manifest.json", body: packageBuildManifest, mode: 0o644 },
    { path: `package/${descriptor.executable}`, body: executable, mode: 0o755 },
    { path: "package/sbom.spdx.json", body: sbom, mode: 0o644 },
    { path: "package/LICENSE", body: license, mode: 0o644 },
    { path: "package/NOTICE", body: notice, mode: 0o644 }
  ];
  let filtered = entries;
  if (input.omit !== undefined) {
    filtered = entries.filter((entry) => entry.path !== input.omit);
  }
  if (input.badMode !== undefined) {
    filtered = filtered.map((entry) => {
      if (entry.path !== input.badMode) return entry;
      return { ...entry, mode: 0o777 };
    });
  }
  let regularFileBytes = 0;
  let executableBytes = 0;
  const executablePath = `package/${descriptor.executable}`;
  for (const entry of filtered) {
    const isDir = entry.path === "package" || entry.path.endsWith("/bin");
    if (isDir) continue;
    const size = typeof entry.body === "string"
      ? Buffer.byteLength(entry.body, "utf8")
      : entry.body.byteLength;
    regularFileBytes += size;
    if (entry.path === executablePath) executableBytes = size;
  }
  const bytes = gzipSync(buildUstar(filtered));
  const integrity = sha512Integrity(createHash("sha512").update(bytes).digest("hex"));
  return {
    bytes,
    integrity,
    tarballUrl: canonicalNpmTarballUrl(input.packageName, input.version),
    executableBytes,
    regularFileBytes
  };
}

function buildUstar(
  entries: ReadonlyArray<{ path: string; body: string | Buffer; mode: number }>
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body, "utf8") : entry.body;
    const isDir = entry.path === "package" || entry.path.endsWith("/bin");
    const type = isDir ? 0x35 : 0x30;
    const size = type === 0x35 ? 0 : body.byteLength;
    const header = Buffer.alloc(512, 0);
    header.write(entry.path, 0, "utf8");
    header.write(octal(entry.mode, 7), 100, "utf8");
    header.write(octal(0, 7), 108, "utf8");
    header.write(octal(0, 7), 116, "utf8");
    header.write(octal(size, 11), 124, "utf8");
    header.write(octal(Math.floor(Date.now() / 1000), 11), 136, "utf8");
    header[156] = type;
    header.write("ustar", 257, "utf8");
    header.write("00", 263, "utf8");
    header.write(" ".repeat(8), 148, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${octal(sum, 6)}\0 `, 148, "utf8");
    chunks.push(header);
    if (size > 0) {
      chunks.push(body);
      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

export function managedScratchRoot(prefix = "managed-"): string {
  const base = path.join(homedir(), ".cache", "1667-tests");
  mkdirSync(base, { recursive: true, mode: 0o755 });
  chmodSync(base, 0o755);
  return realpathSync(mkdtempSync(path.join(base, prefix)));
}

export function writeManagedStub(
  filePath: string,
  version: string,
  target: BuiltArtifactTarget = MANAGED_TEST_TARGET
): void {
  writeFileSync(filePath, stubExecutableSource(version, target), { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

export function shellManagedAuthority(
  installRoot: string,
  channel: "stable" | "beta" = "beta",
  activeVersion: string = MANAGED_TEST_CURRENT,
  target: BuiltArtifactTarget = MANAGED_TEST_TARGET
): {
  authority: Extract<InstallationAuthority, { kind: "shell" }>;
  paths: ReturnType<typeof managedInstallPaths>;
  record: ReturnType<typeof createInstallOwnershipRecord>;
} {
  const paths = managedInstallPaths(installRoot);
  writeManagedStub(paths.active, activeVersion, target);
  const record = createInstallOwnershipRecord({
    installationId: randomBytes(16).toString("hex"),
    channel,
    installRoot,
    executable: paths.active,
    artifactTarget: target
  });
  writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
  chmodSync(paths.ownership, 0o600);
  return {
    paths,
    record,
    authority: {
      kind: "shell",
      record,
      installRoot,
      executable: paths.active
    }
  };
}

export function managedTxn(
  phase: "candidate-ready" | "ownership-pending",
  record: ReturnType<typeof createInstallOwnershipRecord>,
  activeVersion: string,
  candidateVersion: string
) {
  return {
    kind: "managed" as const,
    schemaVersion: 1 as const,
    phase,
    operation: "upgrade" as const,
    channel: record.channel,
    updateChannel: false,
    activeVersion,
    candidateVersion,
    installationId: record.installationId,
    installRoot: record.installRoot,
    executable: record.executable,
    artifactTarget: record.artifactTarget
  };
}

export function fakeManagedRegistry(
  head: string,
  packageName: PlatformPackage,
  integrity: string,
  tarball: string
): UpgradeRegistry {
  return {
    async channelHead(_channel: UpgradeChannel) {
      return head;
    },
    async launcher(version: string) {
      return { name: "@1667-ai/cli", version, integrity, tarball };
    },
    async platform(name: PlatformPackage, version: string) {
      return {
        name: name === packageName ? name : packageName,
        version,
        integrity,
        tarball
      };
    }
  };
}
