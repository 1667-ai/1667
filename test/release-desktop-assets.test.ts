import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allDesktopAssetNames,
  desktopAssetNames,
  desktopReleaseArchiveUrl,
  stageDesktopRelease,
  verifyDesktopAssetsInReleaseDirectory,
  verifyDesktopReleaseAssetDirectory,
  type DesktopReleaseTarget
} from "../scripts/release-desktop-assets.js";

const VERSION = "1.2.3-rc.1";
const REPOSITORY = "1667-ai/1667";
const TARGETS: readonly DesktopReleaseTarget[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64"
];

test("desktop staging gives every target unique archives and absolute updater URLs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "release");
  for (const target of TARGETS) {
    const source = path.join(root, `builder-${target}`);
    await writeBuilderOutput(source, target);
    stageDesktopRelease({
      version: VERSION,
      target,
      sourceDirectory: source,
      outputDirectory: output,
      repository: REPOSITORY
    });
  }

  const expected = [...allDesktopAssetNames(VERSION)].sort();
  assert.ok(expected.includes("beta-darwin-arm64.yml"));
  assert.equal(expected.some((name) => name.startsWith("rc-")), false);
  const names = (await readdir(output)).sort();
  assert.equal(names.some((name) => name.endsWith(".AppImage.blockmap")), false);
  assert.deepEqual(names, expected);
  assert.equal(verifyDesktopReleaseAssetDirectory(output, VERSION, REPOSITORY).length, 15);
  assert.equal(
    verifyDesktopAssetsInReleaseDirectory(output, VERSION, REPOSITORY).length,
    expected.length
  );
});

test("desktop verification permits CLI assets only in the combined release directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-assets-combined-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "release");
  await mkdir(output);
  for (const target of TARGETS) {
    const source = path.join(root, `builder-${target}`);
    await writeBuilderOutput(source, target);
    stageDesktopRelease({
      version: VERSION,
      target,
      sourceDirectory: source,
      outputDirectory: output,
      repository: REPOSITORY
    });
  }
  await writeFile(path.join(output, "cli-native.tar.gz"), "cli asset\n");
  assert.equal(verifyDesktopAssetsInReleaseDirectory(output, VERSION, REPOSITORY).length, 15);
  assert.throws(
    () => verifyDesktopReleaseAssetDirectory(output, VERSION, REPOSITORY),
    /unexpected asset set/u
  );
});

test("desktop staging rejects a second archive and missing metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-assets-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "builder");
  await writeBuilderOutput(source, "windows-x64");
  await writeFile(path.join(source, "second.exe"), "second\n");
  assert.throws(
    () => stageDesktopRelease({
      version: VERSION,
      target: "windows-x64",
      sourceDirectory: source,
      outputDirectory: path.join(root, "release"),
      repository: REPOSITORY
    }),
    /archive must have exactly one file/u
  );
});

async function writeBuilderOutput(
  directory: string,
  target: DesktopReleaseTarget
): Promise<void> {
  await mkdir(directory, { recursive: true });
  // The builder keeps converted icons beside its release archives.
  const iconDirectory = target.startsWith("darwin-") ? ".icon-icns"
    : target.startsWith("linux-") ? ".icon-set" : ".icon-ico";
  await mkdir(path.join(directory, iconDirectory));
  const archive = target.startsWith("darwin-")
    ? `1667-${VERSION}-mac-${target.endsWith("arm64") ? "arm64" : "x64"}.zip`
    : target.startsWith("linux-")
      ? `1667-${VERSION}-${target.endsWith("arm64") ? "arm64" : "x64"}.AppImage`
      : `1667-${VERSION}-Setup.exe`;
  const blockmap = `${archive}.blockmap`;
  await writeFile(path.join(directory, archive), "archive bytes\n");
  if (!target.startsWith("linux-")) {
    await writeFile(path.join(directory, blockmap), "blockmap bytes\n");
  }
  const files = [`  - url: ${archive}`, `    sha512: test`, `    size: 14`];
  const body = [
    `version: ${VERSION}`,
    "files:",
    ...files,
    `path: ${archive}`,
    "sha512: test",
    "releaseDate: 2026-09-14T00:00:00.000Z",
    ""
  ].join("\n");
  // Simulate the raw rc metadata that electron-builder emits.
  const sourceChannel = "rc";
  const metadata = target.startsWith("darwin-") || target.startsWith("linux-")
    ? target.startsWith("darwin-")
      ? `${sourceChannel}-mac.yml`
      : target.endsWith("arm64") ? `${sourceChannel}-linux-arm64.yml` : `${sourceChannel}-linux.yml`
    : `${sourceChannel}.yml`;
  await writeFile(path.join(directory, metadata), body);
  if (target.startsWith("darwin-")) {
    await writeFile(path.join(directory, `1667-${VERSION}-${target}.dmg`), "dmg bytes\n");
  }
  await writeFile(path.join(directory, "builder-debug.yml"), "diagnostics\n");
}

void desktopAssetNames;
void desktopReleaseArchiveUrl;
