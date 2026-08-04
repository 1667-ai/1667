import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "../scripts/release-github-assets.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import { expectedGitHubReleaseAssetNames, expectedInstallerNames } from "../scripts/release-publication-assets.js";

/** This repository's own root, two directories above this fixture file
 * (test/release-npm-github-fixture.ts -> test/ -> repository root) — the
 * same `fileURLToPath(import.meta.url)` pattern release-source-facts.ts,
 * release-content.ts, and release-sbom.ts each use for their own file. */
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Shared fixture infrastructure for the GitHub-release side of the release
 * pipeline — split out of test/release-npm-ci.test.ts so test/release-npm-ci.test.ts
 * and test/release-channel-e2e.test.ts both drive `publishOrVerifyGitHubRelease`
 * and `verifyNpmReleaseAssetDirectory` against the same fake `gh` and the same
 * asset-directory builder, following the split-fixture pattern
 * test/sampling-e2e-fixtures.ts already established.
 */

/** A release asset directory a real workflow run would hand to npm
 * publication: every archive, SBOM, observation, and manifest name the
 * release policy expects, plus the channel-appropriate Installers the real
 * renderer produces and the checksums the real formatter produces. Nothing
 * here hard-codes a channel — `expectedGitHubReleaseAssetNames` and
 * `renderInstallScriptsForVersion` both derive it from `version`, so this
 * fixture is exactly as channel-aware as the release path it stands in for. */
export async function writeReleaseAssetFixture(
  directory: string,
  version: string,
  repository: string
): Promise<void> {
  const installerNames = new Set(expectedInstallerNames(version));
  const names = expectedGitHubReleaseAssetNames(version).filter((name) => {
    return name !== "checksums.txt" && !installerNames.has(name);
  });
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), `${name}\n`)));
  await writeArchiveDependentAssets(directory, version, repository);
}

/**
 * The asset directory `release-github.yml`'s archive path produces: native
 * archives, the channel-appropriate Installers, and checksums.txt — no npm
 * tarballs, no observations, no SBOMs, no artifact manifest. Issue #5 review:
 * this is what `assertGitHubReleaseCompatibleForPublication` (and, later and
 * too late, `publishOrVerifyGitHubRelease`) has to refuse to publish npm
 * packages alongside, because it is missing everything npm publication's own
 * asset set requires.
 */
export async function writeArchiveOnlyReleaseAssetFixture(
  directory: string,
  version: string,
  repository: string
): Promise<void> {
  const archiveNames = PUBLISHED_ARTIFACT_TARGETS.map((target) => releaseArchiveFileName(version, target));
  await Promise.all(archiveNames.map((name) => writeFile(path.join(directory, name), `${name}\n`)));
  await writeArchiveDependentAssets(directory, version, repository);
}

async function writeArchiveDependentAssets(
  directory: string,
  version: string,
  repository: string
): Promise<void> {
  const digests: Record<string, string> = {};
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const archive = releaseArchiveFileName(version, target);
    const bytes = await readFile(path.join(directory, archive));
    digests[archive] = createHash("sha256").update(bytes).digest("hex");
  }
  const scripts = renderInstallScriptsForVersion({ version, repository, digests });
  await Promise.all(
    Object.entries(scripts).map(([name, body]) => writeFile(path.join(directory, name), body))
  );
  await writeFile(
    path.join(directory, "checksums.txt"),
    formatReleaseChecksums(directoryAssetDigests(directory))
  );
}

/**
 * A standalone copy of the checkout `scripts/release-github-assets.ts`
 * itself needs to run `check` and `stage` for real: `release-source-facts.ts`,
 * `release-content.ts`, and `release-sbom.ts` each locate the repository root
 * from their own file's `import.meta.url`, not from an argument, so the only
 * way to make the real `check`/`stage` commands see a stable version's own
 * package manifests is to give them a real checkout whose manifests actually
 * say so. Copying `scripts/`, `shared/`, `server/`, `schema/`, `LICENSE`,
 * `NOTICE`, and the two lockfiles reproduces every file that call graph
 * reads (`schema/` is the SBOM JSON Schema release-sbom-schema.ts loads by
 * relative path), and
 * rewriting only the version fields in the three manifests leaves everything
 * else (including the pinned LICENSE and NOTICE digests) byte-identical to
 * this checkout. `node_modules` is symlinked rather than copied: Node
 * resolves a bare specifier like `ajv` (release-sbom-schema.ts) by walking up
 * from the importing file's own location, not from the process's cwd, so the
 * copied scripts need a `node_modules` to find under them.
 */
export async function createStandaloneReleaseCheckout(
  root: string,
  version: string
): Promise<string> {
  const checkout = path.join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  await Promise.all([
    cp(path.join(REPOSITORY_ROOT, "scripts"), path.join(checkout, "scripts"), { recursive: true }),
    cp(path.join(REPOSITORY_ROOT, "shared"), path.join(checkout, "shared"), { recursive: true }),
    cp(path.join(REPOSITORY_ROOT, "server"), path.join(checkout, "server"), { recursive: true }),
    cp(path.join(REPOSITORY_ROOT, "schema"), path.join(checkout, "schema"), { recursive: true }),
    copyFile(path.join(REPOSITORY_ROOT, "LICENSE"), path.join(checkout, "LICENSE")),
    copyFile(path.join(REPOSITORY_ROOT, "NOTICE"), path.join(checkout, "NOTICE")),
    symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(checkout, "node_modules"),
      "dir"
    )
  ]);
  await mkdir(path.join(checkout, "tui"), { recursive: true });
  await copyFile(
    path.join(REPOSITORY_ROOT, "tui", "bun.lockb"),
    path.join(checkout, "tui", "bun.lockb")
  );
  await Promise.all([
    writeVersionedPackageManifest(
      path.join(REPOSITORY_ROOT, "package.json"),
      path.join(checkout, "package.json"),
      version
    ),
    writeVersionedPackageManifest(
      path.join(REPOSITORY_ROOT, "tui", "package.json"),
      path.join(checkout, "tui", "package.json"),
      version
    ),
    writeVersionedLockfile(
      path.join(REPOSITORY_ROOT, "package-lock.json"),
      path.join(checkout, "package-lock.json"),
      version
    )
  ]);
  return checkout;
}

async function writeVersionedPackageManifest(
  source: string,
  destination: string,
  version: string
): Promise<void> {
  const manifest = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeVersionedLockfile(
  source: string,
  destination: string,
  version: string
): Promise<void> {
  const lockfile = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
  lockfile.version = version;
  const packages = lockfile.packages as Record<string, unknown> | undefined;
  const rootPackage = packages?.[""] as Record<string, unknown> | undefined;
  if (rootPackage === undefined) throw new Error("package-lock.json has no root package entry");
  rootPackage.version = version;
  await writeFile(destination, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

/**
 * A fake `gh` CLI standing in for the GitHub release the workflow creates.
 * `create` reads `isPrerelease` from whether the real command line carries
 * `--prerelease`, and `edit` carries that same recorded value forward,
 * instead of assuming a channel — the same channel-blind approach
 * `publishOrVerifyGitHubRelease` itself has to take, so this fixture can
 * prove the stable path and the prerelease path both without lying to
 * either about what state a real `gh` would report.
 *
 * `view` answers only the fields named after `--json`, the same as the real
 * CLI: two callers ask for different field sets (`releaseState` asks for
 * three fields; `existingReleaseAssets` also asks for `assets`), and a fixture
 * that always returned every field would let a caller's exact-key validation
 * pass on a response the real CLI would never send it.
 */
export function fakeReleaseGh(paths: {
  readonly remote: string;
  readonly state: string;
  readonly log: string;
}): string {
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    `const remote = ${JSON.stringify(paths.remote)};`,
    `const state = ${JSON.stringify(paths.state)};`,
    `fs.appendFileSync(${JSON.stringify(paths.log)}, \`\${JSON.stringify(args)}\\n\`);`,
    "const command = args[1];",
    "if (command === \"view\") {",
    "  if (!fs.existsSync(state)) { process.stderr.write(\"release not found\\n\"); process.exit(1); }",
    "  const current = JSON.parse(fs.readFileSync(state, \"utf8\"));",
    "  const jsonIndex = args.indexOf(\"--json\");",
    "  const fields = jsonIndex === -1 ? [] : args[jsonIndex + 1].split(\",\");",
    "  const out = {};",
    "  for (const field of fields) {",
    "    if (field === \"assets\") {",
    "      out.assets = fs.existsSync(remote)",
    "        ? fs.readdirSync(remote).map((name) => ({ name }))",
    "        : [];",
    "    } else if (Object.hasOwn(current, field)) {",
    "      out[field] = current[field];",
    "    }",
    "  }",
    "  process.stdout.write(JSON.stringify(out));",
    "} else if (command === \"create\") {",
    "  fs.mkdirSync(remote, { recursive: true });",
    "  for (const file of args.slice(3)) {",
    "    if (file.startsWith(\"--\")) break;",
    "    fs.copyFileSync(file, path.join(remote, path.basename(file)));",
    "  }",
    "  const prerelease = args.includes(\"--prerelease\");",
    "  fs.writeFileSync(state, JSON.stringify({isDraft:true,isImmutable:false,isPrerelease:prerelease}));",
    "} else if (command === \"download\") {",
    "  const destination = args[args.indexOf(\"--dir\") + 1];",
    "  for (const name of fs.readdirSync(remote)) {",
    "    fs.copyFileSync(path.join(remote, name), path.join(destination, name));",
    "  }",
    "} else if (command === \"edit\") {",
    "  const current = JSON.parse(fs.readFileSync(state));",
    "  fs.writeFileSync(",
    "    state,",
    "    JSON.stringify({isDraft:false,isImmutable:true,isPrerelease:current.isPrerelease})",
    "  );",
    "} else if (command === \"delete\") {",
    "  fs.rmSync(remote, { recursive: true, force: true });",
    "  fs.rmSync(state, { force: true });",
    "} else {",
    "  process.stderr.write(`unsupported ${args.join(\" \")}\\n`);",
    "  process.exit(2);",
    "}",
    ""
  ].join("\n");
}
