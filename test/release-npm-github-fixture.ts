import { createHash } from "node:crypto";
import {
  chmod,
  readFile,
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
import {
  expectedGitHubReleaseAssetNames,
  expectedInstallerNames
} from "../scripts/release-publication-assets.js";

const RELEASE_GH_FIXTURE = fileURLToPath(
  new URL("fixtures/release-gh.cjs", import.meta.url)
);

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

export interface FakeReleaseGhOptions {
  readonly tagCommit?: string;
  readonly branchCommit?: string;
  readonly tagObjectSha?: string;
  readonly tagObjectTargetType?: "commit" | "tag";
  readonly immutableTagRuleset?: boolean;
  readonly omitBypassActors?: boolean;
  readonly rulesetUpdatedAt?: string;
  readonly createdPrerelease?: boolean;
  readonly moveTagAfterDownloadTo?: string;
  readonly failEditAfterWrite?: boolean;
  readonly tamperBodyOnEdit?: boolean;
}

export async function writeFakeReleaseGh(
  executable: string,
  paths: {
    readonly remote: string;
    readonly state: string;
    readonly log: string;
  },
  options: FakeReleaseGhOptions = {}
): Promise<void> {
  const scenario = {
    schemaVersion: 1,
    remote: path.resolve(paths.remote),
    state: path.resolve(paths.state),
    log: path.resolve(paths.log),
    tagCommit: options.tagCommit ?? "0123456789abcdef0123456789abcdef01234567",
    branchCommit: options.branchCommit ?? null,
    tagObjectSha: options.tagObjectSha ?? null,
    tagObjectTargetType: options.tagObjectTargetType ?? "commit",
    immutableTagRuleset: options.immutableTagRuleset ?? true,
    omitBypassActors: options.omitBypassActors ?? false,
    rulesetUpdatedAt: options.rulesetUpdatedAt ?? "2026-08-05T10:12:37.419Z",
    createdPrerelease: options.createdPrerelease ?? null,
    moveTagAfterDownloadTo: options.moveTagAfterDownloadTo ?? null,
    failEditAfterWrite: options.failEditAfterWrite ?? false,
    tamperBodyOnEdit: options.tamperBodyOnEdit ?? false
  };
  await writeFile(`${executable}.scenario.json`, JSON.stringify(scenario));
  await writeFile(executable, [
    `#!${process.execPath}`,
    `require(${JSON.stringify(RELEASE_GH_FIXTURE)});`,
    ""
  ].join("\n"));
  await chmod(executable, 0o755);
}
