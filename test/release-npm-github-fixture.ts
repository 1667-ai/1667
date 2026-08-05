import { createHash } from "node:crypto";
import {
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import {
  directoryAssetDigests,
  formatReleaseChecksums
} from "../scripts/release-github-assets.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import { expectedGitHubReleaseAssetNames, expectedInstallerNames } from "../scripts/release-publication-assets.js";

/**
 * Shared fixture infrastructure for the GitHub-release side of the release
 * pipeline — split out of test/release-npm-ci.test.ts so test/release-npm-ci.test.ts
 * and test/release-channel-policy.test.ts both drive `publishOrVerifyGitHubRelease`
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
 * A fake `gh` CLI standing in for the GitHub release the workflow creates.
 * `create` reads `isPrerelease` from whether the real command line carries
 * `--prerelease`, and `edit` carries that same recorded value forward,
 * instead of assuming a channel — the same channel-blind approach
 * `publishOrVerifyGitHubRelease` itself has to take, so this fixture can
 * prove the stable path and the prerelease path both without lying to
 * either about what state a real `gh` would report.
 *
 * `view` answers only the fields named after `--json`, the same as the real
 * CLI. A fixture that always returned every field would let exact-key
 * validation pass on a response the real CLI would never send.
 */
export function fakeReleaseGh(paths: {
  readonly remote: string;
  readonly state: string;
  readonly log: string;
}, options: {
  readonly tagCommit?: string;
  readonly branchCommit?: string;
  readonly tagObjectSha?: string;
  readonly immutableTagRuleset?: boolean;
  readonly omitBypassActors?: boolean;
  readonly rulesetUpdatedAt?: string;
  readonly moveTagAfterDownloadTo?: string;
} = {}): string {
  const initialTagCommit = options.tagCommit
    ?? "0123456789abcdef0123456789abcdef01234567";
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    `const remote = ${JSON.stringify(paths.remote)};`,
    `const state = ${JSON.stringify(paths.state)};`,
    `const tagState = ${JSON.stringify(`${paths.state}.tag`)};`,
    `const initialTagCommit = ${JSON.stringify(initialTagCommit)};`,
    `const branchCommit = ${JSON.stringify(options.branchCommit)};`,
    `const tagObjectSha = ${JSON.stringify(options.tagObjectSha)};`,
    `const immutableTagRuleset = ${JSON.stringify(options.immutableTagRuleset ?? true)};`,
    `const omitBypassActors = ${JSON.stringify(options.omitBypassActors ?? false)};`,
    `const rulesetUpdatedAt = ${JSON.stringify(options.rulesetUpdatedAt ?? "2026-08-05T10:12:37.419Z")};`,
    `const moveTagAfterDownloadTo = ${JSON.stringify(options.moveTagAfterDownloadTo)};`,
    `fs.appendFileSync(${JSON.stringify(paths.log)}, \`\${JSON.stringify(args)}\\n\`);`,
    "const command = args[1];",
    "if (args[0] === \"api\" && args[1].endsWith(\"/rulesets?per_page=100\")) {",
    "  process.stdout.write(JSON.stringify([{",
    "    id: 20399162, name: \"tag: v* immutable\", target: \"tag\",",
    "    updated_at: rulesetUpdatedAt,",
    "    enforcement: immutableTagRuleset ? \"active\" : \"disabled\"",
    "  }]));",
    "} else if (args[0] === \"api\" && args[1].endsWith(\"/rulesets/20399162\")) {",
    "  process.stdout.write(JSON.stringify({",
    "    id: 20399162, name: \"tag: v* immutable\", target: \"tag\",",
    "    updated_at: rulesetUpdatedAt,",
    "    enforcement: immutableTagRuleset ? \"active\" : \"disabled\",",
    "    ...(omitBypassActors ? {} : {bypass_actors: []}),",
    "    conditions: {ref_name: {include: [\"refs/tags/v*\"], exclude: []}},",
    "    rules: [{type:\"update\"},{type:\"deletion\"},{type:\"non_fast_forward\"}]",
    "  }));",
    "} else if (args[0] === \"api\" && args[1].includes(\"/git/ref/tags/\")) {",
    "  const sha = fs.existsSync(tagState)",
    "    ? fs.readFileSync(tagState, \"utf8\")",
    "    : initialTagCommit;",
    "  const tag = decodeURIComponent(args[1].split(\"/\").at(-1));",
    "  process.stdout.write(JSON.stringify({",
    "    ref: \"refs/tags/\" + tag,",
    "    object: {type: tagObjectSha === undefined ? \"commit\" : \"tag\",",
    "      sha: tagObjectSha === undefined ? sha : tagObjectSha}",
    "  }));",
    "} else if (args[0] === \"api\" && args[1].includes(\"/git/tags/\")) {",
    "  const sha = fs.existsSync(tagState)",
    "    ? fs.readFileSync(tagState, \"utf8\")",
    "    : initialTagCommit;",
    "  process.stdout.write(JSON.stringify({object:{type:\"commit\",sha}}));",
    "} else if (args[0] === \"api\" && args[1].includes(\"/commits/\")) {",
    "  process.stdout.write(JSON.stringify({sha: branchCommit ?? initialTagCommit}));",
    "} else if (command === \"view\") {",
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
    "  fs.writeFileSync(state, JSON.stringify({",
    "    isDraft:true,isImmutable:false,isPrerelease:prerelease",
    "  }));",
    "} else if (command === \"download\") {",
    "  const destination = args[args.indexOf(\"--dir\") + 1];",
    "  for (const name of fs.readdirSync(remote)) {",
    "    fs.copyFileSync(path.join(remote, name), path.join(destination, name));",
    "  }",
    "  if (moveTagAfterDownloadTo !== undefined) {",
    "    fs.writeFileSync(tagState, moveTagAfterDownloadTo);",
    "  }",
    "} else if (command === \"edit\") {",
    "  const current = JSON.parse(fs.readFileSync(state));",
    "  fs.writeFileSync(",
    "    state,",
    "    JSON.stringify({...current,isDraft:false,isImmutable:true})",
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
