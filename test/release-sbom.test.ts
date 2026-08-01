import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  BUILT_ARTIFACT_TARGETS,
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_TARGETS,
  releaseTargetForArtifact,
  type BuiltArtifactTarget
} from "../shared/release-targets.js";
import {
  createReleaseLauncherManifest,
  RELEASE_LICENSE_FILE_DIGESTS
} from "../scripts/release-package-manifests.js";
import {
  MAX_RELEASE_SBOM_BYTES,
  validateReleaseTarballInspection
} from "../scripts/release-package-policy.js";
import {
  RELEASE_BUN_RUNTIME,
  RELEASE_SBOM_EXCLUDED_PACKAGES,
  releaseBundledComponents,
  releaseInventoriedPackageNames,
  releaseLockfilePackageNames,
  type ReleaseComponentSources
} from "../scripts/release-sbom-components.js";
import {
  launcherSbomDocument,
  platformSbomDocument,
  spdxTimestamp,
  type SpdxDocument,
  type SpdxPackage
} from "../scripts/release-sbom-document.js";
import {
  createReleaseSboms,
  releaseSbomForPackage,
  type ReleaseSbom
} from "../scripts/release-sbom.js";
import {
  createReleaseSbomSource,
  type ReleaseSbomSource
} from "../scripts/release-sbom-source.js";
import {
  createSpdxValidator,
  loadSpdxSchema,
  SPDX_SCHEMA_SHA256,
  spdxSchemaPath
} from "../scripts/release-sbom-schema.js";

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMESTAMP = "2026-07-23T10:20:30.000Z";

const source = createReleaseSbomSource({
  productVersion: "3.0.0",
  sourceCommit: SOURCE_COMMIT,
  tagName: "v3.0.0",
  buildTimestamp: BUILD_TIMESTAMP
});

/** The real repository lockfiles: the only two dependency sources involved. */
function repositorySources(): ReleaseComponentSources {
  return {
    npmLockfile: parseJsonRejectingDuplicateKeys(
      readFileSync(path.join(REPOSITORY_ROOT, "package-lock.json"), "utf8")
    ),
    bunLockfile: readFileSync(path.join(REPOSITORY_ROOT, "tui", "bun.lockb"))
  };
}

function packageNames(document: SpdxDocument): readonly string[] {
  return document.packages.map((entry) => entry.name).sort();
}

function packageNamed(document: SpdxDocument, name: string): SpdxPackage {
  const found = document.packages.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${document.name} does not list ${name}`);
  return found;
}

/** The one machine-readable identifier a consumer matches on. */
function purlOf(document: SpdxDocument, name: string): string {
  const refs = packageNamed(document, name).externalRefs ?? [];
  assert.equal(refs.length, 1, `${name} must carry exactly one external reference`);
  const ref = refs[0];
  if (ref === undefined) throw new Error(`${name} carries no external reference`);
  assert.equal(ref.referenceCategory, "PACKAGE-MANAGER");
  assert.equal(ref.referenceType, "purl");
  return ref.referenceLocator;
}

function platformSbom(set: ReturnType<typeof createReleaseSboms>, target: string): ReleaseSbom {
  const found = set.platforms.find((entry) => entry.artifactTarget === target);
  if (found === undefined) throw new Error(`no SBOM for ${target}`);
  return found;
}

function relationshipExists(
  document: SpdxDocument,
  fromName: string,
  type: string,
  toName: string
): boolean {
  const from = packageNamed(document, fromName).SPDXID;
  const to = packageNamed(document, toName).SPDXID;
  return document.relationships.some((entry) => {
    return entry.spdxElementId === from
      && entry.relationshipType === type
      && entry.relatedSpdxElement === to;
  });
}

test("release SBOM generation is byte-for-byte deterministic", () => {
  const first = createReleaseSboms(source, repositorySources());
  const second = createReleaseSboms(source, repositorySources());
  const flatten = (set: ReturnType<typeof createReleaseSboms>): readonly ReleaseSbom[] => {
    return [set.launcher, ...set.platforms];
  };
  const left = flatten(first);
  const right = flatten(second);
  // One document per staged package: every built platform, plus the launcher.
  assert.equal(left.length, BUILT_ARTIFACT_TARGETS.length + 1);
  for (const [index, sbom] of left.entries()) {
    const other = right[index];
    if (other === undefined) throw new Error("regeneration produced fewer documents");
    assert.equal(sbom.packageName, other.packageName);
    assert.equal(sbom.text, other.text);
    assert.equal(sbom.sha256, other.sha256);
    assert.equal(sbom.sha256, createHash("sha256").update(sbom.text, "utf8").digest("hex"));
  }
  const digests = new Set(left.map((sbom) => sbom.sha256));
  assert.equal(digests.size, left.length, "no document may be a copy of another");
});

test("release SBOM generation rejects authorization evidence", () => {
  const authorizationEvidence = {
    ...source,
    tagSignature: "verified"
  } as unknown as ReleaseSbomSource;
  const sources = repositorySources();
  const components = releaseBundledComponents(sources, "linux-x64");
  for (const generate of [
    () => createReleaseSboms(authorizationEvidence, sources),
    () => launcherSbomDocument(authorizationEvidence),
    () => platformSbomDocument(authorizationEvidence, "linux-x64", components)
  ]) {
    assert.throws(generate, /Release SBOM source has unknown or missing fields/u);
  }
});

test("release SBOM generation rejects a non-SemVer product version", () => {
  assert.throws(
    () => createReleaseSboms(
      { ...source, productVersion: "3.0" },
      repositorySources()
    ),
    /invalid product version/u
  );
});

test("release SBOM generation rejects a noncanonical source commit", () => {
  assert.throws(
    () => createReleaseSboms(
      { ...source, sourceCommit: SOURCE_COMMIT.toUpperCase() },
      repositorySources()
    ),
    /invalid source commit/u
  );
});

test("release SBOM generation rejects a noncanonical build timestamp", () => {
  assert.throws(
    () => createReleaseSboms(
      { ...source, buildTimestamp: "2026-07-23T10:20:30Z" },
      repositorySources()
    ),
    /invalid build timestamp/u
  );
});

test("release SBOM generation rejects a tag that does not match the version", () => {
  assert.throws(
    () => createReleaseSboms(
      { ...source, tagName: "v3.0.1" },
      repositorySources()
    ),
    /tag does not match/u
  );
});

test("release SBOM generation rejects a coercible non-string source field", () => {
  const coercibleCommit = {
    toString: () => SOURCE_COMMIT
  } as unknown as string;
  assert.throws(
    () => createReleaseSboms(
      { ...source, sourceCommit: coercibleCommit },
      repositorySources()
    ),
    /sourceCommit must be a non-empty string/u
  );
});

test("one release SBOM set snapshots getter-backed source facts once", () => {
  let sourceCommitReads = 0;
  const getterBackedSource = {
    ...source,
    get sourceCommit(): string {
      sourceCommitReads += 1;
      return sourceCommitReads === 1 ? SOURCE_COMMIT : "f".repeat(40);
    }
  };
  const set = createReleaseSboms(getterBackedSource, repositorySources());
  assert.equal(sourceCommitReads, 1);
  for (const sbom of [set.launcher, ...set.platforms]) {
    assert.match(sbom.document.documentNamespace, new RegExp(`${SOURCE_COMMIT}$`, "u"));
    assert.equal(
      packageNamed(sbom.document, "1667").downloadLocation,
      `git+https://github.com/1667-ai/1667.git@${SOURCE_COMMIT}`
    );
  }
});

test("release SBOM documents carry no time source but the release build timestamp", () => {
  const set = createReleaseSboms(source, repositorySources());
  const expected = spdxTimestamp(BUILD_TIMESTAMP);
  assert.equal(expected, "2026-07-23T10:20:30Z");
  for (const sbom of [set.launcher, ...set.platforms]) {
    assert.equal(sbom.document.creationInfo.created, expected);
    const timestamps = sbom.text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gu) ?? [];
    assert.ok(timestamps.length > 0);
    for (const stamp of timestamps) assert.equal(`${stamp}Z`, expected);
    assert.doesNotMatch(sbom.text, /urn:uuid/u);
  }
});

test("every release SBOM validates against the vendored SPDX 2.3 schema", () => {
  const digest = createHash("sha256").update(readFileSync(spdxSchemaPath())).digest("hex");
  assert.equal(digest, SPDX_SCHEMA_SHA256);
  const schema = loadSpdxSchema();
  assert.equal(schema["$id"], "http://spdx.org/rdf/terms/2.3");
  const validate = createSpdxValidator();
  const set = createReleaseSboms(source, repositorySources());
  for (const sbom of [set.launcher, ...set.platforms]) {
    validate(parseJsonRejectingDuplicateKeys(sbom.text));
    assert.equal(sbom.document.spdxVersion, "SPDX-2.3");
    assert.equal(sbom.document.dataLicense, "CC0-1.0");
  }
  assert.throws(() => validate({ spdxVersion: "SPDX-2.3" }), /not a valid SPDX 2.3 document/u);
});

test("a platform SBOM names the product, the embedded runtime and every bundled dependency", () => {
  const set = createReleaseSboms(source, repositorySources());
  const document = platformSbom(set, "linux-x64").document;
  assert.deepEqual(packageNames(document), [
    "1667",
    "@opentui/core",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "bun",
    "fs-ext-extra-prebuilt",
    "msgpackr",
    "tiktoken",
    "web-tree-sitter"
  ]);

  const product = packageNamed(document, "1667");
  assert.equal(product.versionInfo, "3.0.0");
  assert.equal(product.licenseDeclared, "Apache-2.0");
  assert.equal(product.packageFileName, "bin/1667");
  assert.deepEqual(document.documentDescribes, [product.SPDXID]);

  const runtime = packageNamed(document, "bun");
  assert.equal(runtime.versionInfo, "1.3.14");
  assert.equal(runtime.licenseDeclared, "MIT");

  const expected = new Map([
    ["tiktoken", ["1.0.22", "MIT",
      "3cabf2d6b545d5189b7c5dc99570523f426b730daeab7c977607045ed293627d"
      + "d027f7014411c39eb2798c7932f8c10d67a0c83f0354196a64571fbb8e80a934"]],
    ["fs-ext-extra-prebuilt", ["2.2.9", "MIT",
      "34e2ff059d3f15dd0ca9bf0fb0680567d4d9a9b62ede54df7d2d2e70681d27cc"
      + "6d124033f872e4bb526edf4121769be0ed7339905d4f7c9605ff06cee47af8d9"]],
    ["msgpackr", ["2.0.5", "MIT",
      "71e7f4e47fdd498a4ba6aa77b23feac99879be151809a96768b3bb8f5c8e9a9b"
      + "11d32fd7c0b56d2bbaf9827f94fc5ec24c47cca307068655102432dc2dfee370"]],
    ["@opentui/core", ["0.4.5", "MIT",
      "26c8114cf900e9ef95c66ba6c5a8ba48494e4a545091bccd2879427de9a502b4"
      + "622e17c2d4867d457268d901f8c52bbeb8139600cf74bacb3bdffa4f9647448a"]],
    ["@opentui/core-linux-x64", ["0.4.5", "MIT",
      "48dcae428c4c288d6fb89860c52496f7a69d58ce8ba859764a84b718ce2d19e9"
      + "de18e6a75551b6634e8fbe5cad5ef17870a8a4f7bb74aea9153117ad98eb3ddf"]],
    ["web-tree-sitter", ["0.25.10", "MIT",
      "634f6c178e3fd775ef8152a03b670d0f0e6b1a4eacdba320a193d72c44af3177"
      + "9e7c17fb8baffbdde16eaeb7b422c4d6e84d7863402b2338543268e873bc72cc"]]
  ]);
  for (const [name, [version, license, sha512]] of expected) {
    const entry = packageNamed(document, name);
    assert.equal(entry.versionInfo, version);
    assert.equal(entry.licenseConcluded, license);
    assert.equal(entry.licenseDeclared, license);
    assert.deepEqual(entry.checksums, [{ algorithm: "SHA512", checksumValue: sha512 }]);
    assert.equal(entry.downloadLocation.startsWith("https://registry.npmjs.org/"), true);
  }
});

test("every component carries a canonical package URL", () => {
  const set = createReleaseSboms(source, repositorySources());
  const platform = platformSbom(set, "linux-x64").document;

  // An npm scope is the purl namespace: `@` percent-encoded, `/` left literal.
  // Encoding the separator instead yields a locator no vulnerability or licence
  // database indexes, so every scoped component would silently match nothing.
  assert.equal(purlOf(platform, "@opentui/core"), "pkg:npm/%40opentui/core@0.4.5");
  assert.equal(
    purlOf(platform, "@opentui/core-linux-x64-musl"),
    "pkg:npm/%40opentui/core-linux-x64-musl@0.4.5"
  );
  assert.equal(purlOf(platform, "tiktoken"), "pkg:npm/tiktoken@1.0.22");
  assert.equal(purlOf(platform, "web-tree-sitter"), "pkg:npm/web-tree-sitter@0.25.10");
  assert.equal(purlOf(platform, "bun"), "pkg:github/oven-sh/bun@bun-v1.3.14");

  const launcher = releaseSbomForPackage(set, RELEASE_LAUNCHER_PACKAGE).document;
  assert.equal(purlOf(launcher, "@1667-ai/linux-x64"), "pkg:npm/%401667-ai/linux-x64@3.0.0");
  assert.equal(purlOf(launcher, "@1667-ai/darwin-arm64"), "pkg:npm/%401667-ai/darwin-arm64@3.0.0");

  // The described product needs a locator too. Without one the document names
  // every dependency a scanner can resolve and omits the one it is issued for,
  // so nothing matches the release back to the package it ships as.
  for (const sbom of [set.launcher, ...set.platforms]) {
    assert.equal(
      purlOf(sbom.document, "1667"),
      `pkg:npm/%40${sbom.packageName.slice("@".length)}@3.0.0`,
      `${sbom.packageName} does not identify itself`
    );
  }

  for (const sbom of [set.launcher, ...set.platforms]) {
    for (const entry of sbom.document.packages) {
      for (const ref of entry.externalRefs ?? []) {
        assert.doesNotMatch(
          ref.referenceLocator,
          /%2[Ff]/u,
          `${entry.name} percent-encodes its scope separator`
        );
      }
    }
  }
});

test("the product's download location puts the commit in the SPDX revision slot", () => {
  const set = createReleaseSboms(source, repositorySources());
  // `<vcs>+<transport>://<host>/<path>[@<revision>][#<sub_path>]`: after `#`
  // the commit would name a path inside the checkout, not the revision.
  const expected = `git+https://github.com/1667-ai/1667.git@${SOURCE_COMMIT}`;
  for (const sbom of [set.launcher, ...set.platforms]) {
    assert.equal(packageNamed(sbom.document, "1667").downloadLocation, expected);
    assert.doesNotMatch(sbom.text, /1667\.git#/u);
  }
});

test("a platform SBOM relates the product to the runtime and to what pulls each dependency in", () => {
  const set = createReleaseSboms(source, repositorySources());
  const document = platformSbom(set, "linux-x64").document;
  const product = packageNamed(document, "1667").SPDXID;
  assert.ok(document.relationships.some((entry) => {
    return entry.spdxElementId === "SPDXRef-DOCUMENT"
      && entry.relationshipType === "DESCRIBES"
      && entry.relatedSpdxElement === product;
  }));
  for (const name of [
    "bun",
    "tiktoken",
    "fs-ext-extra-prebuilt",
    "msgpackr",
    "@opentui/core",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "web-tree-sitter"
  ]) {
    assert.ok(
      relationshipExists(document, "1667", "CONTAINS", name),
      `1667 must contain ${name}`
    );
  }
  for (const name of ["tiktoken", "fs-ext-extra-prebuilt", "msgpackr", "@opentui/core"]) {
    assert.ok(relationshipExists(document, "1667", "DEPENDS_ON", name));
  }
  for (const name of [
    "@opentui/core-linux-x64",
    "@opentui/core-linux-x64-musl",
    "web-tree-sitter"
  ]) {
    assert.ok(
      relationshipExists(document, "@opentui/core", "DEPENDS_ON", name),
      `@opentui/core must depend on ${name}`
    );
  }
  assert.equal(relationshipExists(document, "1667", "DEPENDS_ON", "web-tree-sitter"), false);
});

test("each platform SBOM names only its own target's native library", () => {
  const set = createReleaseSboms(source, repositorySources());
  // Total over the target union, so restoring or adding a target fails to
  // compile here rather than comparing against a silent undefined.
  const expected: Record<BuiltArtifactTarget, readonly string[]> = {
    "darwin-arm64": ["@opentui/core-darwin-arm64"],
    "darwin-x64": ["@opentui/core-darwin-x64"],
    "linux-arm64": ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"],
    "linux-x64": ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"],
    "windows-x64": ["@opentui/core-win32-x64"]
  };
  // Every built target, held or not: a platform document follows staging, and a
  // held target is staged and packed like any other. Narrowing this loop to the
  // published targets would leave the windows-x64 row above compared to nothing.
  for (const target of BUILT_ARTIFACT_TARGETS) {
    const sbom = platformSbom(set, target);
    assert.equal(sbom.packageName, releaseTargetForArtifact(target).packageName);
    const native = sbom.document.packages
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("@opentui/core-"))
      .sort();
    assert.deepEqual(native, expected[target]);
    assert.equal(
      sbom.document.name,
      `${releaseTargetForArtifact(target).packageName}@3.0.0`
    );
  }
  // Publication is the other question, and the launcher's document is what
  // answers it: a held target has its own document and stays out of that list.
  const launcher = releaseSbomForPackage(set, RELEASE_LAUNCHER_PACKAGE).document;
  for (const descriptor of RELEASE_TARGETS) {
    if (descriptor.heldFromPublication === null) continue;
    assert.equal(
      releaseSbomForPackage(set, descriptor.packageName).artifactTarget,
      descriptor.artifactTarget
    );
    assert.equal(
      launcher.packages.some((entry) => entry.name === descriptor.packageName),
      false,
      `the launcher must not pin the held ${descriptor.packageName}`
    );
  }
});

test("the launcher SBOM is a different document, not a platform copy", () => {
  const set = createReleaseSboms(source, repositorySources());
  const launcher = releaseSbomForPackage(set, RELEASE_LAUNCHER_PACKAGE).document;
  assert.deepEqual(packageNames(launcher), ["1667", ...[...PUBLISHED_PLATFORM_PACKAGES].sort()]);
  assert.equal(packageNamed(launcher, "1667").packageFileName, "bin/1667.js");
  assert.match(launcher.comment, /embeds no language runtime and bundles no third-party code/u);
  for (const name of ["bun", "@opentui/core", "tiktoken", "fs-ext-extra-prebuilt"]) {
    assert.equal(
      launcher.packages.some((entry) => entry.name === name),
      false,
      `the launcher must not claim to ship ${name}`
    );
  }
  for (const packageName of PUBLISHED_PLATFORM_PACKAGES) {
    const entry = packageNamed(launcher, packageName);
    assert.equal(entry.versionInfo, "3.0.0");
    assert.equal(entry.licenseDeclared, "Apache-2.0");
    assert.equal(Object.hasOwn(entry, "checksums"), false);
    assert.ok(relationshipExists(launcher, packageName, "OPTIONAL_DEPENDENCY_OF", "1667"));
  }
  assert.equal(launcher.relationships.length, PUBLISHED_PLATFORM_PACKAGES.length + 1);

  const platform = platformSbom(set, "linux-x64").document;
  assert.notEqual(launcher.documentNamespace, platform.documentNamespace);
  const shared = packageNames(launcher).filter((name) => packageNames(platform).includes(name));
  assert.deepEqual(shared, ["1667"], "only the product is common to both documents");
});

/**
 * A launcher tarball whose `sbom.spdx.json` entry is the given size. Nothing
 * stages that file yet, so this fixture describes the entry the staging step
 * will produce; the only property assertable today is that the generator and
 * the entry policy enforce one and the same bound.
 */
function launcherInspectionWithSbomBytes(bytes: number): ReturnType<
  typeof validateReleaseTarballInspection
> {
  const digest = (label: string): string => {
    return createHash("sha256").update(label, "utf8").digest("hex");
  };
  return validateReleaseTarballInspection({
    packageJsonSha256: digest("package.json"),
    entries: [
      { path: "package", type: "directory", mode: 0o755, size: 0, sha256: null },
      { path: "package/bin", type: "directory", mode: 0o755, size: 0, sha256: null },
      {
        path: "package/package.json",
        type: "file",
        mode: 0o644,
        size: 512,
        sha256: digest("package.json")
      },
      {
        path: "package/bin/1667.js",
        type: "file",
        mode: 0o755,
        size: 8192,
        sha256: digest("launcher")
      },
      {
        path: "package/build-manifest.json",
        type: "file",
        mode: 0o644,
        size: 256,
        sha256: digest("build-manifest")
      },
      {
        path: "package/sbom.spdx.json",
        type: "file",
        mode: 0o644,
        size: bytes,
        sha256: digest("sbom")
      },
      {
        path: "package/LICENSE",
        type: "file",
        mode: 0o644,
        size: RELEASE_LICENSE_FILE_DIGESTS.LICENSE.bytes,
        sha256: RELEASE_LICENSE_FILE_DIGESTS.LICENSE.sha256
      },
      {
        path: "package/NOTICE",
        type: "file",
        mode: 0o644,
        size: RELEASE_LICENSE_FILE_DIGESTS.NOTICE.bytes,
        sha256: RELEASE_LICENSE_FILE_DIGESTS.NOTICE.sha256
      }
    ]
  }, createReleaseLauncherManifest("3.0.0"));
}

test("the generator and the staged-entry policy enforce the same size bound", () => {
  const set = createReleaseSboms(source, repositorySources());
  for (const entry of [set.launcher, ...set.platforms]) {
    assert.ok(entry.bytes > 0 && entry.bytes <= MAX_RELEASE_SBOM_BYTES);
    assert.equal(entry.bytes, Buffer.byteLength(entry.text, "utf8"));
  }
  const accepted = launcherInspectionWithSbomBytes(MAX_RELEASE_SBOM_BYTES);
  assert.equal(
    accepted.entries.find((entry) => entry.path === "package/sbom.spdx.json")?.size,
    MAX_RELEASE_SBOM_BYTES
  );
  assert.throws(
    () => launcherInspectionWithSbomBytes(MAX_RELEASE_SBOM_BYTES + 1),
    /package\/sbom\.spdx\.json exceeds its size bound/u
  );
});

/**
 * Every workflow that compiles an executable with `bun build --compile`.
 * `release-github.yml` is the pin that compiles what a user downloads;
 * `ci.yml` is the pin that compiles what every change is tested against. Both
 * must install the same Bun, because one declared runtime goes into the SBOM
 * inside every archive.
 */
const BUN_COMPILING_WORKFLOWS = [
  "ci.yml",
  "release-github.yml",
  "release-npm.yml"
] as const;

/**
 * The Bun version the workflows install. `bun build --compile` embeds the
 * compiling toolchain's own runtime, so this pin — not the `engines` floor in
 * `tui/package.json` — is the fact that decides what the executable ships, and
 * the SBOM in each archive declares it to whoever downloads the archive.
 * Reading one workflow would let the other be bumped alone, and every archive
 * built by the bumped one would then ship an SPDX document naming a Bun it
 * does not embed: a false statement inside the bytes the attestation vouches
 * for, in the document whose purpose is a vulnerability lookup.
 */
function pinnedWorkflowBunVersion(): string {
  const pins: string[] = [];
  for (const file of BUN_COMPILING_WORKFLOWS) {
    const workflow = readFileSync(
      path.join(REPOSITORY_ROOT, ".github", "workflows", file),
      "utf8"
    );
    const found = [...workflow.matchAll(/^[ \t]*bun-version:[ \t]*(\S+)[ \t]*$/gmu)]
      .map((match) => match[1] as string);
    assert.ok(found.length > 0, `${file} pins no Bun version`);
    pins.push(...found);
  }
  const distinct = [...new Set(pins)];
  assert.equal(
    distinct.length,
    1,
    `${BUN_COMPILING_WORKFLOWS.join(" and ")} pin several Bun versions: ${distinct.join(", ")}`
  );
  const pinned = distinct[0];
  if (pinned === undefined) throw new Error("the workflows pin no Bun version");
  return pinned;
}

test("the pinned runtime and TUI inventory stay bound to the repository's own inputs", () => {
  const tuiManifest = parseJsonRejectingDuplicateKeys(
    readFileSync(path.join(REPOSITORY_ROOT, "tui", "package.json"), "utf8")
  ) as { engines: { bun: string }; dependencies: Record<string, string> };
  assert.equal(
    RELEASE_BUN_RUNTIME.version,
    pinnedWorkflowBunVersion(),
    "the declared runtime must be the version the release workflow installs"
  );
  assert.equal(RELEASE_BUN_RUNTIME.purl, `pkg:github/oven-sh/bun@bun-v${RELEASE_BUN_RUNTIME.version}`);
  assert.equal(
    RELEASE_BUN_RUNTIME.downloadLocation,
    `https://github.com/oven-sh/bun/releases/tag/bun-v${RELEASE_BUN_RUNTIME.version}`
  );
  assert.equal(tuiManifest.engines.bun, `>=${RELEASE_BUN_RUNTIME.version}`);

  const sources = repositorySources();
  const components = releaseBundledComponents(sources, "linux-x64");
  const core = components.find((entry) => entry.name === "@opentui/core");
  assert.ok(core !== undefined);
  assert.equal(core.version, tuiManifest.dependencies["@opentui/core"]);

  const lockfile = parseJsonRejectingDuplicateKeys(
    readFileSync(path.join(REPOSITORY_ROOT, "package-lock.json"), "utf8")
  ) as { packages: Record<string, { version: string; license: string; integrity: string }> };
  for (const name of ["tiktoken", "fs-ext-extra-prebuilt", "msgpackr"]) {
    const component = components.find((entry) => entry.name === name);
    const locked = lockfile.packages[`node_modules/${name}`];
    assert.ok(component !== undefined && locked !== undefined);
    assert.equal(component.version, locked.version);
    assert.equal(component.license, locked.license);
    assert.equal(
      component.sha512,
      Buffer.from(locked.integrity.slice("sha512-".length), "base64").toString("hex")
    );
  }
});

test("every pinned TUI digest is a digest tui/bun.lockb actually records", () => {
  const sources = repositorySources();
  const lockfile = Buffer.from(sources.bunLockfile);
  // The lockfile stores integrity as the 64 raw bytes of the digest, not as the
  // ASCII `sha512-<base64>` form npm writes. That is why the pins are checkable
  // at all, and why scanning for the ASCII form would find nothing.
  assert.equal(lockfile.includes(Buffer.from("sha512-", "utf8")), false);
  for (const target of BUILT_ARTIFACT_TARGETS) {
    for (const component of releaseBundledComponents(sources, target)) {
      if (!component.name.startsWith("@opentui/") && component.name !== "web-tree-sitter") continue;
      assert.equal(component.sha512.length, 128);
      assert.ok(
        lockfile.includes(Buffer.from(component.sha512, "hex")),
        `${component.name} pins a digest tui/bun.lockb does not record`
      );
    }
  }
});

test("an inventory the repository's lockfiles do not support is refused", () => {
  const sources = repositorySources();
  assert.throws(
    () => releaseBundledComponents(
      { npmLockfile: sources.npmLockfile, bunLockfile: Buffer.from("not a lockfile") },
      "linux-x64"
    ),
    /is not the version tui\/bun\.lockb resolves/u
  );
  // A lockfile that resolves every expected tarball but records none of the
  // pinned digests: the version binding passes and the digest binding refuses.
  const urlsOnly = Buffer.from([
    "https://registry.npmjs.org/@opentui/core/-/core-0.4.5.tgz",
    "https://registry.npmjs.org/web-tree-sitter/-/web-tree-sitter-0.25.10.tgz",
    "https://registry.npmjs.org/@opentui/core-linux-x64/-/core-linux-x64-0.4.5.tgz",
    "https://registry.npmjs.org/@opentui/core-linux-x64-musl/-/core-linux-x64-musl-0.4.5.tgz"
  ].join("\n"), "utf8");
  assert.throws(
    () => releaseBundledComponents(
      { npmLockfile: sources.npmLockfile, bunLockfile: urlsOnly },
      "linux-x64"
    ),
    /@opentui\/core@0\.4\.5 is not the digest tui\/bun\.lockb records/u
  );
  assert.throws(
    () => releaseBundledComponents(
      { npmLockfile: { packages: {} }, bunLockfile: sources.bunLockfile },
      "linux-x64"
    ),
    /has no node_modules\/fs-ext-extra-prebuilt entry/u
  );
});

test("the inventory and its exclusions account for every package in both lockfiles", () => {
  const inventoried = new Set(releaseInventoriedPackageNames());
  const excluded = new Map(
    RELEASE_SBOM_EXCLUDED_PACKAGES.map((entry) => [entry.name, entry.reason])
  );
  assert.equal(excluded.size, RELEASE_SBOM_EXCLUDED_PACKAGES.length, "an exclusion is repeated");
  for (const [name, reason] of excluded) {
    assert.ok(reason.trim().length > 0, `${name} is excluded without a stated reason`);
    assert.equal(inventoried.has(name), false, `${name} is both inventoried and excluded`);
  }

  // The inventory is a whitelist, so on its own a newly bundled dependency
  // would be omitted from every document in silence. Requiring the two tables
  // to cover the lockfiles exactly turns that into a named failure, in both
  // directions: an addition is unaccounted for, a removal leaves a stale entry.
  const locked = new Set(releaseLockfilePackageNames(repositorySources()));
  for (const name of locked) {
    assert.ok(
      inventoried.has(name) || excluded.has(name),
      `${name} is in a lockfile but is neither inventoried nor explicitly excluded`
    );
  }
  for (const name of inventoried) {
    assert.ok(locked.has(name), `${name} is inventoried but neither lockfile records it`);
  }
  for (const name of excluded.keys()) {
    assert.ok(locked.has(name), `${name} is excluded but neither lockfile records it`);
  }
  assert.equal(locked.size, inventoried.size + excluded.size);
});

test("an empty inventory cannot be published as a well-formed document", () => {
  assert.throws(
    () => platformSbomDocument(source, "linux-x64", []),
    /would list no components/u
  );
});
