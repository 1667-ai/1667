import {
  releaseTargetForArtifact,
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_TARGETS,
  type BuiltArtifactTarget,
  type CanonicalReleaseTarget
} from "../shared/release-targets.js";
import { isSemVer, parseSemVer } from "../shared/semver.js";
import { releaseArchiveFileName } from "./release-archive.js";

export const RELEASE_REPOSITORY_SLUG = "1667-ai/1667" as const;

const PLATFORM_LABELS: Readonly<Record<CanonicalReleaseTarget["platform"], string>> = Object.freeze({
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows"
});

/**
 * The notes for one GitHub pre-release. Everything here has to be true of the
 * artifacts this workflow actually produces, so the download table, the verify
 * command, and the held-target paragraph are all derived from the same target
 * policy the workflow builds from. Clearing `heldFromPublication` in
 * `shared/release-targets.ts` moves a target into the table and out of this
 * paragraph without an edit here.
 *
 * Nothing here claims a position in the release history. The workflow can be
 * dispatched again at any version, and these notes are generated from the
 * version alone, so a sentence that is true only of the first release would go
 * false with no edit and no failing check. Every sentence therefore has to hold
 * for the tenth dispatch as well as the first, or be derived from a fact this
 * repository checks.
 *
 * Two claims stay carefully bounded. There is no signed-tag provenance: the
 * evidence this release offers is the build-provenance attestation, and the
 * notes say only that. The Shell Installer is a pinned release asset. The
 * one-line homepage command trusts 1667.ai; attestation of the script is the
 * stronger optional path.
 */
export function releaseNotesMarkdown(version: string): string {
  if (!isSemVer(version)) throw new Error(`Release notes need a SemVer version, not ${version}`);
  const first = PUBLISHED_ARTIFACT_TARGETS[0];
  if (first === undefined) throw new Error("Release notes need at least one published target");
  const sample = releaseArchiveFileName(version, first);
  const sampleStem = sample.replace(/\.tar\.gz$/u, "");
  return [
    `# 1667 v${version}`,
    "",
    "Native builds of 1667, a full-screen terminal environment for writing fiction",
    "with language models. Every release on this path is a pre-release: the",
    "interface, the stored data format, and the packaging can still change between",
    "versions.",
    "",
    "## Downloads",
    "",
    "| Target | Archive |",
    "| --- | --- |",
    ...PUBLISHED_ARTIFACT_TARGETS.map((target) => {
      return `| ${targetLabel(target)} | \`${releaseArchiveFileName(version, target)}\` |`;
    }),
    "",
    "`checksums.txt` holds the SHA-256 digest of each archive and install script above.",
    "",
    "Each archive extracts into one directory holding the executable, `LICENSE`,",
    "`NOTICE`, `build-manifest.json`, and `sbom.spdx.json`. The executable needs",
    "neither Bun nor Node.js at run time.",
    "",
    "This release also includes `install-beta.sh`. The script embeds this version,",
    "the beta channel, each archive name, and each archive SHA-256 digest. It never",
    "resolves GitHub latest and never reads npm tags.",
    "",
    "## Verify what you downloaded, then run it",
    "",
    "Every archive, install script, and `checksums.txt` has a GitHub",
    "build-provenance attestation. The attestation is signed and publicly logged.",
    "It states that this repository's release workflow produced the exact bytes",
    "from this commit.",
    "Check it before you run anything.",
    "",
    "```sh",
    `gh attestation verify ${sample} --repo ${RELEASE_REPOSITORY_SLUG}`,
    `tar -xzf ${sample}`,
    `./${sampleStem}/1667 --version`,
    "```",
    "",
    "Optional stronger install path:",
    "",
    "```sh",
    `gh attestation verify install-beta.sh --repo ${RELEASE_REPOSITORY_SLUG}`,
    "sh ./install-beta.sh",
    "```",
    "",
    "That attestation is the evidence this release offers. There is no signed tag",
    "here, and nothing above asks you to check one.",
    "",
    ...reservedVersionNote(version),
    ...heldTargetSection(),
    "## Report a problem",
    "",
    `Open an issue at https://github.com/${RELEASE_REPOSITORY_SLUG}/issues. Include the`,
    "output of `1667 --version --json`, which names the exact build you are running.",
    ""
  ].join("\n");
}

/**
 * Why the version carries a prerelease identifier. npm cannot republish a
 * version, so a stable number is never spent on a preview. A stable release
 * says nothing here.
 *
 * Every sentence has to hold for the tenth release as well as the first, so
 * this states the standing rule and the two version strings it produced,
 * rather than anything about which release this is.
 */
function reservedVersionNote(version: string): readonly string[] {
  const parsed = parseSemVer(version);
  if (parsed === null || parsed.prerelease.length === 0) return [];
  const stable = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return [
    `This build is \`${version}\`, a preview of \`${stable}\`. A stable number is not`,
    "spent on a preview, because npm cannot replace a version once it is published.",
    ""
  ];
}

/**
 * Which targets are absent and what a reader may assume about them. The names
 * are derived — clearing `heldFromPublication` empties this section — but the
 * verification claim is not, and must not be written as one this repository
 * cannot keep. A held target is not necessarily a built one: routine CI does
 * not compile every target today, so promising that a held target is "built and
 * tested on every change" would be a false assurance handed to the one reader
 * who is about to build from source. Claim nothing continuous: say the target
 * is not built here now, that the source still compiles, and that what a reader
 * builds is unverified. That stays true whether CI coverage widens or narrows,
 * and a reader who is told nothing verifies it cannot be misled by a promise
 * that quietly lapsed.
 */
function heldTargetSection(): readonly string[] {
  const held: readonly string[] = RELEASE_TARGETS
    .filter((descriptor) => descriptor.heldFromPublication !== null)
    .map((descriptor) => descriptor.artifactTarget);
  if (held.length === 0) return [];
  const names = held.map((target) => `\`${target}\``).join(", ");
  const single = held.length === 1;
  return [
    "## Targets not published here",
    "",
    `${names} ${single ? "is" : "are"} not in this release, and ${single ? "is" : "are"} not`,
    "built by this repository's CI at the moment. The source still compiles",
    `${single ? "it" : "them"}: run \`bun run build:standalone\` in \`tui/\`. Nothing is`,
    "verifying that build today, so treat what you get as untested. Held back",
    "from distribution, not dropped.",
    ""
  ];
}

function targetLabel(target: BuiltArtifactTarget): string {
  const descriptor = releaseTargetForArtifact(target);
  const libc = descriptor.libc === null ? "" : ` (${descriptor.libc})`;
  return `${PLATFORM_LABELS[descriptor.platform]} ${descriptor.arch}${libc}`;
}
