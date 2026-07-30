/** External Shell Installer harness with a local GitHub Release asset server. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { releaseArchiveFileName, releaseArchiveStem } from "../scripts/release-archive.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  execFileAsync,
  sha256File,
  writePublishedArchives
} from "./release-install-script-fixture.js";

export interface InstallerArchiveHarness {
  readonly root: string;
  readonly target: BuiltArtifactTarget;
  readonly archivePath: string;
  readonly archiveName: string;
  readonly stem: string;
  run(
    label: string,
    writeArchive: (archivePath: string) => Promise<void>,
    scriptMutator?: (body: string) => string
  ): Promise<{ readonly stdout: string; readonly prefix: string }>;
  reject(
    label: string,
    writeArchive: (archivePath: string) => Promise<void>,
    pattern: RegExp,
    scriptMutator?: (body: string) => string
  ): Promise<void>;
}

export async function createInstallerArchiveHarness(
  t: TestContext,
  target: BuiltArtifactTarget,
  label: string
): Promise<InstallerArchiveHarness> {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, `${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));

  const archiveName = releaseArchiveFileName(INSTALL_VERSION, target);
  const stem = releaseArchiveStem(INSTALL_VERSION, target);
  const archivesDir = path.join(root, "archives");
  await mkdir(archivesDir, { recursive: true });
  const archivePath = path.join(archivesDir, archiveName);
  const server = createArchiveServer(archivesDir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Shell Installer test server address is missing");
  }
  const assetBaseUrl = `http://127.0.0.1:${address.port}`;

  async function run(
    runLabel: string,
    writeArchive: (path: string) => Promise<void>,
    scriptMutator?: (body: string) => string
  ): Promise<{ readonly stdout: string; readonly prefix: string }> {
    await writeArchive(archivePath);
    const digests = await writePublishedArchives(
      path.join(root, `digests-${runLabel}`),
      INSTALL_VERSION
    );
    digests[archiveName] = sha256File(await readFile(archivePath));
    let script = renderInstallScriptsForVersion({
      version: INSTALL_VERSION,
      repository: INSTALL_REPO,
      digests,
      assetBaseUrl
    })["install-beta.sh"]!;
    if (scriptMutator !== undefined) script = scriptMutator(script);
    const scriptPath = path.join(root, `install-${runLabel}.sh`);
    await writeFile(scriptPath, script, { mode: 0o755 });
    const prefix = path.join(root, `prefix-${runLabel}`);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const { stdout } = await execFileAsync(
      "sh",
      [scriptPath, "--prefix", prefix],
      { cwd: root }
    );
    return { stdout, prefix };
  }

  return Object.freeze({
    root,
    target,
    archivePath,
    archiveName,
    stem,
    run,
    async reject(
      runLabel: string,
      writeArchive: (archivePath: string) => Promise<void>,
      pattern: RegExp,
      scriptMutator?: (body: string) => string
    ): Promise<void> {
      await assert.rejects(
        run(runLabel, writeArchive, scriptMutator),
        pattern,
        runLabel
      );
    }
  });
}

function createArchiveServer(archivesDir: string): Server {
  return createServer((request, response) => {
    const file = path.join(archivesDir, path.basename(request.url ?? ""));
    void readFile(file).then((bytes) => {
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
