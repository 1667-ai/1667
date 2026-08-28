import {
  releaseTargetForArtifact,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import {
  PI_AI_BUNDLED_PACKAGE_NAMES,
  PI_AI_TREE_SHAKEN_PACKAGE_NAMES
} from "./release-sbom-pi-ai.js";

/** The name and version of a component listed in the same inventory. */
export interface ReleaseComponentRef {
  readonly name: string;
  readonly version: string;
}

export interface ReleaseBundledComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Lower-case hexadecimal SHA-512 of the published registry tarball. */
  readonly sha512: string;
  readonly downloadLocation: string;
  readonly purl: string;
  /**
   * The component that pulls this one in, already resolved against this same
   * inventory; null when the product does. Resolving it here rather than
   * handing a bare name to a later stage keeps one owner for the invariant
   * that every parent is listed, so consumers need no lookup and no fallback.
   */
  readonly requiredBy: ReleaseComponentRef | null;
}

export interface ReleaseRuntimeComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly downloadLocation: string;
  readonly purl: string;
}

export interface ReleaseComponentSources {
  /** Parsed `package-lock.json` from the repository root. */
  readonly npmLockfile: unknown;
  /** Raw bytes of `tui/bun.lockb`. */
  readonly bunLockfile: Uint8Array;
}

/**
 * `bun build --compile` embeds the compiling toolchain's own runtime, so the
 * embedded version is a property of the pinned toolchain rather than of any
 * lockfile. The fact that decides it is the `bun-version` the workflows that
 * compile install; a guard test reads that pin out of both
 * `.github/workflows/ci.yml` and `.github/workflows/release-npm.yml`, and
 * requires a single distinct pin equal to this constant, so bumping either
 * toolchain — or bumping one and not the other — fails the build. Bumping the
 * release workflow alone would ship archives whose SBOM names a runtime they
 * do not embed. `tui/package.json`'s `engines.bun` is a floor rather than a
 * pin and is checked as one.
 */
export const RELEASE_BUN_RUNTIME: ReleaseRuntimeComponent = Object.freeze({
  name: "bun",
  version: "1.4.0",
  license: "MIT",
  downloadLocation: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.0",
  purl: "pkg:github/oven-sh/bun@bun-v1.4.0"
});

/** Root-lockfile packages whose code the bundler pulls into the executable. */
const NPM_BUNDLED_PACKAGES = Object.freeze([
  ...PI_AI_BUNDLED_PACKAGE_NAMES,
  "@silvia-odwyer/photon-node",
  "detect-libc",
  "fs-ext-extra-prebuilt",
  "msgpackr",
  "msgpackr-extract",
  "node-gyp-build-optional-packages",
  "tiktoken"
] as const);

const NPM_BUNDLED_REQUIRED_BY: Readonly<Record<string, string>> = Object.freeze({
  "@anthropic-ai/sdk": "@earendil-works/pi-ai",
  "detect-libc": "node-gyp-build-optional-packages",
  "msgpackr-extract": "msgpackr",
  "node-gyp-build-optional-packages": "msgpackr-extract",
  "partial-json": "@earendil-works/pi-ai",
  "typebox": "@earendil-works/pi-ai"
});

export interface ExcludedReleasePackage {
  readonly name: string;
  /** Why none of this package's bytes reach the compiled executable. */
  readonly reason: string;
}

/**
 * Lockfile packages the executable does not contain, each carrying the reason
 * it is absent.
 *
 * The inventory above is a whitelist. On its own it fails closed when a listed
 * version moves — the lockfile no longer supports the pin — but open when a
 * dependency is added: an unlisted package would simply be missing from every
 * document, silently. This table closes that direction. A guard test requires
 * the inventory and this table together to account for exactly every non-dev
 * package in `package-lock.json` and every registry tarball `tui/bun.lockb`
 * resolves, in both directions, so adding a dependency and dropping one each
 * fail the build by name.
 */
export const RELEASE_SBOM_EXCLUDED_PACKAGES: readonly ExcludedReleasePackage[] = Object.freeze([
  ...PI_AI_TREE_SHAKEN_PACKAGE_NAMES.map((name) => Object.freeze({
    name,
    reason: "Installed for Pi providers that 1667 does not import. The pinned "
      + "Bun metafile contains no module from this package."
  })),
  Object.freeze({
    name: "koffi",
    reason: "Source-only Node HTTP mode uses this FFI package on Linux. The "
      + "compiled Bun executable uses Bun FFI and keeps Koffi external."
  }),
  ...[
    "@koromix/koffi-darwin-arm64",
    "@koromix/koffi-darwin-x64",
    "@koromix/koffi-freebsd-arm64",
    "@koromix/koffi-freebsd-ia32",
    "@koromix/koffi-freebsd-x64",
    "@koromix/koffi-linux-arm64",
    "@koromix/koffi-linux-ia32",
    "@koromix/koffi-linux-loong64",
    "@koromix/koffi-linux-riscv64",
    "@koromix/koffi-linux-x64",
    "@koromix/koffi-openbsd-ia32",
    "@koromix/koffi-openbsd-x64",
    "@koromix/koffi-win32-arm64",
    "@koromix/koffi-win32-ia32",
    "@koromix/koffi-win32-x64"
  ].map((name) => Object.freeze({
    name,
    reason: "Optional native payload for source-only Node HTTP mode. The "
      + "compiled Bun executable uses Bun FFI and keeps Koffi external."
  })),
  ...[
    "@msgpackr-extract/msgpackr-extract-darwin-arm64",
    "@msgpackr-extract/msgpackr-extract-darwin-x64",
    "@msgpackr-extract/msgpackr-extract-linux-arm",
    "@msgpackr-extract/msgpackr-extract-linux-arm64",
    "@msgpackr-extract/msgpackr-extract-linux-x64",
    "@msgpackr-extract/msgpackr-extract-win32-x64"
  ].map((name) => Object.freeze({
    name,
    reason: "Optional native acceleration payload for msgpackr. Shipped code imports "
      + "pure JS msgpackr/unpack so standalone contains no native binary extension."
  })),
  Object.freeze({
    name: "nan",
    reason: "C++ headers that node-gyp consumes while installing "
      + "fs-ext-extra-prebuilt. Listing it would describe the build tree rather "
      + "than the package, which is the failure this document exists to avoid."
  }),
  Object.freeze({
    name: "typescript",
    reason: "TUI development dependency used to type-check the sources. The "
      + "compiled executable contains no compiler."
  }),
  ...["marked", "diff", "string-width", "strip-ansi", "ansi-regex", "emoji-regex",
    "get-east-asian-width", "bun-ffi-structs"].map((name) => Object.freeze({
    name,
    reason: "Declared by @opentui/core, which publishes pre-bundled chunks. It is "
      + "installed but never imported by the shipped build and contributes no bytes."
  })),
  Object.freeze({
    name: "@opentui/core-win32-arm64",
    reason: "Prebuilt native library for a target this project does not build. "
      + "Bun resolves it in the lockfile; no packaged executable embeds it. The "
      + "win32-x64 sibling is built and is inventoried, not excluded."
  })
]);

interface PinnedTuiPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Registry `dist.integrity`, `sha512-<base64>` exactly as published. */
  readonly integrity: string;
  readonly requiredBy: string | null;
}

/**
 * `tui/bun.lockb` is binary, and its layout is undocumented and specific to a
 * Bun release. Parsing that layout would make the bill of materials depend on
 * a Bun implementation detail rather than on a reviewed fact, so nothing here
 * parses it — but two facts are recoverable from the raw bytes without any
 * knowledge of the layout, and both are used. Every resolved registry tarball
 * URL appears in the file as plain text. Integrity appears too, not in the
 * ASCII `sha512-<base64>` form npm writes but as the 64 raw bytes of the
 * digest; the string `sha512-` is absent from the file entirely.
 *
 * So each entry below is rejected unless both its exact tarball URL and the 64
 * bytes its pinned integrity decodes to appear verbatim in the lockfile. That
 * binds the name, the version and the digest to the lockfile the same way the
 * licence file digests are bound to the files on disk, and a stale or
 * transposed pin fails closed instead of shipping a checksum that matches
 * nothing. Only the licence is asserted without a lockfile witness, because
 * the lockfile records none.
 *
 * The set is the executable's real module graph, not the resolved dependency
 * tree: `@opentui/core` publishes pre-bundled chunks, so most of what it
 * declares is installed and never imported. Those packages are named in
 * `RELEASE_SBOM_EXCLUDED_PACKAGES` with their reason rather than left
 * unmentioned. What the bundler does embed is `@opentui/core`, the
 * `web-tree-sitter` WASM runtime it loads for syntax highlighting, and the
 * prebuilt native library for the build host.
 */
const TUI_BUNDLED_PACKAGES: readonly PinnedTuiPackage[] = Object.freeze([
  Object.freeze({
    name: "@opentui/core",
    version: "0.4.5",
    license: "MIT",
    integrity: "sha512-JsgRTPkA6e+Vxmumxai6SElOSlRQkbzNKHlCfemlArRiLhfC1IZ9RXJo2QH4xSu+uBOWAM90uss73/pPlkdEig==",
    requiredBy: null
  }),
  Object.freeze({
    name: "web-tree-sitter",
    version: "0.25.10",
    license: "MIT",
    integrity: "sha512-Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA==",
    requiredBy: "@opentui/core"
  })
]);

/**
 * Prebuilt `libopentui` packages, keyed by the target whose executable embeds
 * them. Both Linux entries carry their musl sibling: Bun installs it despite
 * its `libc: ["musl"]` declaration and embeds both shared objects, so a Linux
 * package that named only the glibc build would understate what it ships.
 * macOS has no musl variant and therefore lists one.
 */
const TUI_NATIVE_PACKAGES: Readonly<Record<BuiltArtifactTarget, readonly PinnedTuiPackage[]>> =
  Object.freeze({
    "darwin-arm64": Object.freeze([nativePackage(
      "@opentui/core-darwin-arm64",
      "sha512-8KUG0oRidnR+oW1RSZJ72/PhZLl+qRRMk5U/mieF4c0SJ5V3tYACpBZAKzQfHNd1f7QzD8FHZct1lPpQgtmkWg=="
    )]),
    "darwin-x64": Object.freeze([nativePackage(
      "@opentui/core-darwin-x64",
      "sha512-R2bocsg55gwjOqCp/MWFgFYzRmsduKegB6nzgFAPCvAD/L5Jf30xpWJWFlSg3x8vxe1L9WJ84dfqa4M7mZZ3wA=="
    )]),
    "linux-arm64": Object.freeze([
      nativePackage(
        "@opentui/core-linux-arm64",
        "sha512-R4MZ25a4CzOAGVjW9aj1hUfzQGVfCJwrwBDbNs2SXaIvzcZqkxCVtU4FoQ5LsaD0j/BdNQVg2CIfFkFsm1fDuQ=="
      ),
      nativePackage(
        "@opentui/core-linux-arm64-musl",
        "sha512-ieqdyKI6EIYPalYAETB2wsdP83hr5Ifi+dFnBFUmdEEFHsoKwBmn2S7bsTOYlX7Bg03F4/YPIg+IvRpeC+cUJw=="
      )
    ]),
    "linux-x64": Object.freeze([
      nativePackage(
        "@opentui/core-linux-x64",
        "sha512-SNyuQoxMKI1vuJhgxSSW96adWM6LqFl2SoS3GM4tGeneGOanVVG2Y06PvlytXvF4cKik97t0rqkVMRetmOs93w=="
      ),
      nativePackage(
        "@opentui/core-linux-x64-musl",
        "sha512-mKVKcIcPiSVVZZsdPSBoWwoa2/TCeQAaMDeHF7PFw2kt5bTXZPP7xxWfRQLCNIcA1eaGl59UuwUWHDR2Ve548Q=="
      )
    ]),
    // Windows ships one library: there is no musl variant to pair with it.
    "windows-x64": Object.freeze([nativePackage(
      "@opentui/core-win32-x64",
      "sha512-Y8T/yXCDGagRGiQrtmuB6AhRcPucKFs/Dre3v8kJwNYqDccI4FzUPKclZ7djfmRZNjl7JUqPhZZP/PwDpQocMg=="
    )])
  });

interface UnresolvedComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly sha512: string;
  readonly downloadLocation: string;
  readonly purl: string;
  readonly requiredByName: string | null;
}

/**
 * Every third-party component embedded in the platform package for `target`,
 * ordered by name so the result never depends on lookup or install order.
 */
export function releaseBundledComponents(
  sources: ReleaseComponentSources,
  target: BuiltArtifactTarget
): readonly ReleaseBundledComponent[] {
  const descriptor = releaseTargetForArtifact(target);
  const lockfile = lockfileBuffer(sources.bunLockfile);
  const pinned = [
    ...TUI_BUNDLED_PACKAGES,
    ...TUI_NATIVE_PACKAGES[descriptor.artifactTarget]
  ];
  const resolved = [
    ...NPM_BUNDLED_PACKAGES.map((name) => npmLockComponent(
      sources.npmLockfile,
      name,
      NPM_BUNDLED_REQUIRED_BY[name] ?? null
    )),
    ...pinned.map((entry) => resolvedTuiComponent(entry, lockfile))
  ];
  resolved.sort((left, right) => compareStrings(left.name, right.name));
  const byName = new Map(resolved.map((entry) => [entry.name, entry]));
  if (byName.size !== resolved.length) {
    throw new Error(`Release SBOM inventory repeats a component for ${target}`);
  }
  return Object.freeze(resolved.map((entry) => {
    const parent = entry.requiredByName === null ? null : byName.get(entry.requiredByName);
    if (parent === undefined) {
      throw new Error(`Release SBOM component ${entry.name} has an unlisted parent`);
    }
    return Object.freeze({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      sha512: entry.sha512,
      downloadLocation: entry.downloadLocation,
      purl: entry.purl,
      requiredBy: parent === null
        ? null
        : Object.freeze({ name: parent.name, version: parent.version })
    });
  }));
}

/**
 * Every package name the inventory can list, across all release targets. The
 * completeness guard subtracts this from what the lockfiles record.
 */
export function releaseInventoriedPackageNames(): readonly string[] {
  const names = new Set<string>(NPM_BUNDLED_PACKAGES);
  for (const entry of TUI_BUNDLED_PACKAGES) names.add(entry.name);
  for (const entries of Object.values(TUI_NATIVE_PACKAGES)) {
    for (const entry of entries) names.add(entry.name);
  }
  return Object.freeze([...names].sort(compareStrings));
}

/**
 * Every package the two lockfiles record: each non-development entry in
 * `package-lock.json`, and each package `tui/bun.lockb` resolves to a registry
 * tarball. Names only — versions belong to the reviewed tables, and this is
 * the set the inventory and its exclusions have to cover between them.
 */
export function releaseLockfilePackageNames(
  sources: ReleaseComponentSources
): readonly string[] {
  const names = new Set<string>(npmLockPackageNames(sources.npmLockfile));
  for (const name of bunLockPackageNames(sources.bunLockfile)) names.add(name);
  return Object.freeze([...names].sort(compareStrings));
}

/**
 * A package URL in canonical form. An npm scope is the purl *namespace*: the
 * leading `@` is percent-encoded and the separating `/` stays literal, giving
 * `pkg:npm/%40opentui/core@0.4.5`. Encoding the separator instead produces a
 * string no consumer indexes, so vulnerability and licence lookups return
 * nothing for exactly the scoped components this document exists to declare.
 */
export function npmPurl(name: string, version: string): string {
  const identifier = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${identifier}@${version}`;
}

export function registryTarballUrl(name: string, version: string): string {
  const segments = name.split("/");
  const basename = segments[segments.length - 1];
  if (basename === undefined || basename.length === 0) {
    throw new Error(`Release SBOM component name ${name} is invalid`);
  }
  return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}

/** Byte-order comparison, so document ordering never depends on a locale. */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function nativePackage(name: string, integrity: string): PinnedTuiPackage {
  return Object.freeze({
    name,
    version: "0.4.5",
    license: "MIT",
    integrity,
    requiredBy: "@opentui/core"
  });
}

function npmLockComponent(
  lockfile: unknown,
  name: string,
  requiredByName: string | null
): UnresolvedComponent {
  const entry = npmLockEntry(lockfile, `node_modules/${name}`);
  if (entry.dev === true) {
    throw new Error(`${name} is not an installed runtime dependency`);
  }
  const version = lockString(entry.version, `${name} version`);
  const expected = registryTarballUrl(name, version);
  const resolved = lockString(entry.resolved, `${name} resolved location`);
  if (resolved !== expected) {
    throw new Error(`${name} does not resolve to the public registry tarball`);
  }
  return Object.freeze({
    name,
    version,
    license: lockString(entry.license, `${name} license`),
    sha512: integrityToHex(lockString(entry.integrity, `${name} integrity`), name),
    downloadLocation: expected,
    purl: npmPurl(name, version),
    requiredByName
  });
}

function resolvedTuiComponent(
  entry: PinnedTuiPackage,
  lockfile: Buffer
): UnresolvedComponent {
  const downloadLocation = registryTarballUrl(entry.name, entry.version);
  if (!lockfile.includes(Buffer.from(downloadLocation, "utf8"))) {
    throw new Error(`${entry.name}@${entry.version} is not the version tui/bun.lockb resolves`);
  }
  const sha512 = integrityToHex(entry.integrity, entry.name);
  if (!lockfile.includes(Buffer.from(sha512, "hex"))) {
    throw new Error(`${entry.name}@${entry.version} is not the digest tui/bun.lockb records`);
  }
  return Object.freeze({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    sha512,
    downloadLocation,
    purl: npmPurl(entry.name, entry.version),
    requiredByName: entry.requiredBy
  });
}

function npmLockPackages(lockfile: unknown): Record<string, unknown> {
  if (lockfile === null || typeof lockfile !== "object" || Array.isArray(lockfile)) {
    throw new Error("Release SBOM npm lockfile must be an object");
  }
  const packages = (lockfile as Record<string, unknown>).packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("Release SBOM npm lockfile has no packages map");
  }
  return packages as Record<string, unknown>;
}

function npmLockEntry(lockfile: unknown, key: string): Record<string, unknown> {
  const entry = npmLockPackages(lockfile)[key];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Release SBOM npm lockfile has no ${key} entry`);
  }
  return entry as Record<string, unknown>;
}

const NODE_MODULES_PREFIX = "node_modules/";

function npmLockPackageNames(lockfile: unknown): readonly string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(npmLockPackages(lockfile))) {
    const marker = key.lastIndexOf(NODE_MODULES_PREFIX);
    if (marker < 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    if ((value as Record<string, unknown>).dev === true) continue;
    const name = key.slice(marker + NODE_MODULES_PREFIX.length);
    if (name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Registry tarball URLs are stored in `tui/bun.lockb` as plain text, so the
 * package names are recoverable by scanning the bytes. Decoding as latin1 maps
 * each byte to one code unit, which leaves the ASCII URLs intact and cannot
 * merge or split them the way a UTF-8 decode of binary data would.
 */
const REGISTRY_TARBALL_PATTERN =
  /https:\/\/registry\.npmjs\.org\/((?:@[^/\s]+\/)?[^/\s]+)\/-\/[^/\s]+\.tgz/gu;

function bunLockPackageNames(bytes: Uint8Array): readonly string[] {
  const text = lockfileBuffer(bytes).toString("latin1");
  const names: string[] = [];
  for (const match of text.matchAll(REGISTRY_TARBALL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function lockfileBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** npm and Bun both publish `sha512-<base64>`; SPDX wants lower-case hex. */
function integrityToHex(integrity: string, label: string): string {
  const encoded = integrity.startsWith("sha512-") ? integrity.slice("sha512-".length) : null;
  if (encoded === null) throw new Error(`${label} integrity is not SHA-512`);
  const digest = Buffer.from(encoded, "base64");
  if (digest.byteLength !== 64 || digest.toString("base64") !== encoded) {
    throw new Error(`${label} integrity is not a well-formed SHA-512 digest`);
  }
  return digest.toString("hex");
}

function lockString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Release SBOM lockfile ${label} must be a non-empty string`);
  }
  return value;
}
