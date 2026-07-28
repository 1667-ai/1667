import {
  releaseTargetForArtifact,
  type CanonicalReleaseTarget,
  type PackagedArtifactTarget
} from "../shared/release-targets.js";
import { isSemVer, parseSemVer } from "../shared/semver.js";
import {
  PUBLICATION_HOLDS,
  PUBLISHED_RELEASE_TARGETS,
  releaseArchiveFileName
} from "./release-publication.js";

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
 * policy the workflow builds from. A target that leaves the hold list appears
 * in the table and leaves this paragraph without an edit here.
 *
 * Two claims are deliberately absent. There is no signed-tag provenance: the
 * evidence this release offers is the build-provenance attestation, and the
 * notes say only that. There is no install script and no one-line shell
 * command that fetches one, because a script cannot establish its own
 * authenticity to a reader who has not yet verified anything.
 */
export function releaseNotesMarkdown(version: string): string {
  if (!isSemVer(version)) throw new Error(`Release notes need a SemVer version, not ${version}`);
  const first = PUBLISHED_RELEASE_TARGETS[0];
  if (first === undefined) throw new Error("Release notes need at least one published target");
  const sample = releaseArchiveFileName(version, first);
  const sampleStem = sample.replace(/\.tar\.gz$/u, "");
  return [
    `# 1667 v${version}`,
    "",
    "The first published builds of 1667, a full-screen terminal environment for",
    "writing fiction with language models. This is a pre-release: the interface, the",
    "stored data format, and the packaging can still change between versions.",
    "",
    "## Downloads",
    "",
    "| Target | Archive |",
    "| --- | --- |",
    ...PUBLISHED_RELEASE_TARGETS.map((target) => {
      return `| ${targetLabel(target)} | \`${releaseArchiveFileName(version, target)}\` |`;
    }),
    "",
    "`checksums.txt` holds the SHA-256 of every archive above.",
    "",
    "Each archive extracts into one directory holding the executable, `LICENSE`,",
    "`NOTICE`, `build-manifest.json`, and `sbom.spdx.json`. The executable needs",
    "neither Bun nor Node.js at run time.",
    "",
    "## Verify what you downloaded, then run it",
    "",
    "Every archive and `checksums.txt` carries a GitHub build-provenance attestation:",
    "a signed, publicly logged statement that this repository's release workflow",
    "produced those exact bytes from this commit. Check it before you run anything.",
    "",
    "```sh",
    `gh attestation verify ${sample} --repo ${RELEASE_REPOSITORY_SLUG}`,
    `tar -xzf ${sample}`,
    `./${sampleStem}/1667 --version`,
    "```",
    "",
    "That attestation is the evidence this release offers. There is no signed tag",
    "here, and nothing above asks you to check one.",
    "",
    "## No install script",
    "",
    "There is no install script, and no one-line shell command that downloads and",
    "runs one. Such a command cannot establish its own authenticity: you would run",
    "it before you had verified anything, which is the step that matters. Download",
    "an archive, verify its attestation, then run the executable.",
    "",
    "## npm",
    "",
    "1667 does not publish an npm package yet. Publication needs setup that is not",
    "finished, and it will be announced in this repository when it is.",
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
 * version, so the stable number is not spent on a preview. A stable release
 * says nothing here.
 */
function reservedVersionNote(version: string): readonly string[] {
  const parsed = parseSemVer(version);
  if (parsed === null || parsed.prerelease.length === 0) return [];
  const stable = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return [
    `This build is \`${version}\`. \`${stable}\` is held for the first npm publication,`,
    "because npm cannot replace a version once it is published.",
    ""
  ];
}

function heldTargetSection(): readonly string[] {
  const held: readonly string[] = PUBLICATION_HOLDS;
  if (held.length === 0) return [];
  const names = held.map((target) => `\`${target}\``).join(", ");
  const single = held.length === 1;
  return [
    "## Targets not published here",
    "",
    `${names} ${single ? "is" : "are"} not in this release. ${single ? "It is" : "They are"}`,
    "built and tested on every change to `main`, and you can build the executable",
    "yourself with `bun run build:standalone` in `tui/`. Held back from",
    "distribution, not dropped.",
    ""
  ];
}

function targetLabel(target: PackagedArtifactTarget): string {
  const descriptor = releaseTargetForArtifact(target);
  const libc = descriptor.libc === null ? "" : ` (${descriptor.libc})`;
  return `${PLATFORM_LABELS[descriptor.platform]} ${descriptor.arch}${libc}`;
}
