import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import { INSTALL_OWNERSHIP_FILE, parseInstallOwnershipRecordText } from "../shared/install-ownership-record.js";
import { INSTALL_PREVIOUS_FILE, INSTALL_TRANSACTION_FILE } from "../shared/install-layout.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import { serializeInstallTransactionRecord } from "../tui/src/install-transaction-record.js";
import {
  INSTALL_PRE_VERSION,
  INSTALL_REPO,
  canonicalTxnBytes,
  INSTALL_VERSION,
  execFileAsync,
  hostShellInstallerTarget,
  releaseStub,
  writePublishedArchives
} from "./release-install-script-fixture.js";

function prettyOwnership(input: {
  readonly id: string;
  readonly channel: "stable" | "beta";
  readonly root: string;
  readonly target: string;
}): string {
  return "{\n"
    + "  \"schemaVersion\": 1,\n"
    + "  \"product\": \"1667\",\n"
    + "  \"installationId\": \"" + input.id + "\",\n"
    + "  \"method\": \"shell\",\n"
    + "  \"channel\": \"" + input.channel + "\",\n"
    + "  \"installRoot\": \"" + input.root + "\",\n"
    + "  \"executable\": \"" + input.root + "/1667\",\n"
    + "  \"artifactTarget\": \"" + input.target + "\"\n"
    + "}\n";
}

function compactOwnership(input: {
  readonly id: string;
  readonly channel: "stable" | "beta";
  readonly root: string;
  readonly target: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: "1667",
    installationId: input.id,
    method: "shell",
    channel: input.channel,
    installRoot: input.root,
    executable: input.root + "/1667",
    artifactTarget: input.target
  }) + "\n";
}

function managedTxn(input: {
  readonly phase: "candidate-ready" | "ownership-pending";
  readonly id: string;
  readonly root: string;
  readonly target: BuiltArtifactTarget;
  readonly activeVersion: string;
  readonly candidateVersion: string;
}): string {
  return serializeInstallTransactionRecord({
    kind: "managed",
    schemaVersion: 1,
    operation: "upgrade",
    channel: "beta",
    updateChannel: true,
    activeVersion: input.activeVersion,
    candidateVersion: input.candidateVersion,
    installationId: input.id,
    installRoot: input.root,
    executable: input.root + "/1667",
    artifactTarget: input.target,
    phase: input.phase
  });
}

async function serveArchives(root: string): Promise<{
  readonly base: string;
  readonly close: () => Promise<void>;
  readonly hits: () => number;
}> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const file = path.join(root, path.basename(request.url ?? ""));
    readFile(file).then((bytes) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  return {
    base: "http://127.0.0.1:" + address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hits: () => requestCount
  };
}

async function writeScript(
  scratch: string,
  archiveDir: string,
  assetBaseUrl: string,
  fileName = "install-beta.sh"
): Promise<string> {
  const digests = await writePublishedArchives(archiveDir, INSTALL_VERSION);
  const scriptPath = path.join(scratch, fileName);
  await writeFile(scriptPath, renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl
  })["install-beta.sh"]!, { mode: 0o755 });
  return scriptPath;
}

async function createScratch(label: string): Promise<string> {
  const parent = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  return await mkdtemp(path.join(parent, label));
}

test("Shell Installer bootstraps old pretty and compact managed records", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  for (const encoding of ["pretty", "compact"] as const) {
    const scratch = await createScratch("bootstrap-");
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const archiveDir = path.join(scratch, "archives");
    await mkdir(archiveDir, { recursive: true });
    const server = await serveArchives(archiveDir);
    t.after(server.close);
    const scriptPath = await writeScript(scratch, archiveDir, server.base, "install-" + encoding + ".sh");
    const prefix = path.join(scratch, "prefix," + encoding);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const id = "0123456789abcdef0123456789abcdef";
    const oldVersion = encoding === "pretty" ? INSTALL_PRE_VERSION : "1.2.3-rc.1+build.7";
    const oldBytes: Buffer = Buffer.from(releaseStub(oldVersion, target));
    await writeFile(path.join(prefix, "1667"), oldBytes, { mode: 0o755 });
    await writeFile(
      path.join(prefix, INSTALL_OWNERSHIP_FILE),
      encoding === "pretty"
        ? prettyOwnership({ id, channel: "stable", root: prefix, target })
        : compactOwnership({ id, channel: "stable", root: prefix, target }),
      { mode: 0o600 }
    );
    // The old updater downloads this file before its pinned NOTICE check fails.
    await writeFile(path.join(prefix, ".1667-package.tgz"), "old failed update\n", {
      mode: 0o600
    });
    await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch });
    assert.notDeepEqual(await readFile(path.join(prefix, "1667")), oldBytes);
    assert.deepEqual(await readFile(path.join(prefix, INSTALL_PREVIOUS_FILE)), oldBytes);
    const ownership = parseInstallOwnershipRecordText(
      await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8")
    );
    assert.equal(ownership.installationId, id);
    assert.equal(ownership.channel, "beta");
    assert.equal(ownership.artifactTarget, target);
    await assert.rejects(readFile(path.join(prefix, ".1667-package.tgz")));
    assert.equal(server.hits(), 1);
  }
});

test("Shell Installer same-version bootstrap preserves rollback bytes and identity", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-same-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const prefix = path.join(scratch, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "abcdefabcdefabcdefabcdefabcdefab";
  const previousBytes = Buffer.from("existing rollback bytes\n");
  await writeFile(path.join(prefix, "1667"), releaseStub(INSTALL_VERSION, target), { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_PREVIOUS_FILE), previousBytes, { mode: 0o755 });
  await writeFile(
    path.join(prefix, INSTALL_OWNERSHIP_FILE),
    prettyOwnership({ id, channel: "stable", root: prefix, target }),
    { mode: 0o600 }
  );
  await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch });
  assert.deepEqual(await readFile(path.join(prefix, INSTALL_PREVIOUS_FILE)), previousBytes);
  const ownership = parseInstallOwnershipRecordText(
    await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8")
  );
  assert.equal(ownership.installationId, id);
  assert.equal(ownership.channel, "beta");
  assert.equal(server.hits(), 0);

  const badPrefix = path.join(scratch, "bad-previous");
  await mkdir(badPrefix, { mode: 0o755 });
  await chmod(badPrefix, 0o755);
  await writeFile(path.join(badPrefix, "1667"), releaseStub(INSTALL_VERSION, target), { mode: 0o755 });
  await writeFile(path.join(badPrefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
    id,
    channel: "stable",
    root: badPrefix,
    target
  }), { mode: 0o600 });
  await mkdir(path.join(badPrefix, INSTALL_PREVIOUS_FILE), { mode: 0o700 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", badPrefix], { cwd: scratch }),
    /rollback executable must be a regular/i
  );
  assert.equal(server.hits(), 0);
});

test("Shell Installer refuses to downgrade a newer managed active", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-downgrade-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const prefix = path.join(scratch, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "0123456789abcdef0123456789abcdef";
  const newerVersion = "2.0.0-rc.1+build.7";
  const activeBytes = Buffer.from(releaseStub(newerVersion, target));
  const ownershipBytes = prettyOwnership({ id, channel: "stable", root: prefix, target });
  await writeFile(path.join(prefix, "1667"), activeBytes, { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), ownershipBytes, { mode: 0o600 });

  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch }),
    /Installer will not downgrade.*1667 upgrade --version 1\.2\.3/i
  );
  assert.deepEqual(await readFile(path.join(prefix, "1667")), activeBytes);
  assert.equal(await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8"), ownershipBytes);
  await assert.rejects(readFile(path.join(prefix, INSTALL_TRANSACTION_FILE)));
  assert.equal(server.hits(), 0);
});

test("Shell Installer refuses an unsafe managed active unless forced", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-safety-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const prefix = path.join(scratch, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "abcdefabcdefabcdefabcdefabcdefab";
  await writeFile(path.join(prefix, "1667"), releaseStub(INSTALL_VERSION, target), { mode: 0o777 });
  await chmod(path.join(prefix, "1667"), 0o777);
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
    id,
    channel: "stable",
    root: prefix,
    target
  }), { mode: 0o600 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch }),
    /managed active executable is writable by every account/i
  );
  await execFileAsync("sh", [scriptPath, "--prefix", prefix, "--force"], { cwd: scratch });
  assert.equal(server.hits(), 0);
});

test("Shell Installer rejects invalid SemVer active and transaction identities", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-semver-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const invalidVersions = ["1.2", "01.2.3", "1.2.3-01", "1.2.3+"];
  for (const [index, invalidVersion] of invalidVersions.entries()) {
    const prefix = path.join(scratch, "invalid-" + index);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const id = ("0000000000000000000000000000000" + index).slice(-32);
    await writeFile(path.join(prefix, "1667"), releaseStub(invalidVersion, target), { mode: 0o755 });
    await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
      id,
      channel: "stable",
      root: prefix,
      target
    }), { mode: 0o600 });
    await assert.rejects(
      execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch }),
      /version is invalid/i
    );
  }

  const txnPrefix = path.join(scratch, "invalid-transaction");
  await mkdir(txnPrefix, { mode: 0o755 });
  await chmod(txnPrefix, 0o755);
  const id = "fedcba9876543210fedcba9876543210";
  await writeFile(path.join(txnPrefix, "1667"), releaseStub(INSTALL_PRE_VERSION, target), { mode: 0o755 });
  await writeFile(path.join(txnPrefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
    id,
    channel: "stable",
    root: txnPrefix,
    target
  }), { mode: 0o600 });
  await writeFile(path.join(txnPrefix, ".1667-install-txn.json"), managedTxn({
    phase: "candidate-ready",
    id,
    root: txnPrefix,
    target,
    activeVersion: INSTALL_PRE_VERSION,
    candidateVersion: "1.2.3-01"
  }), { mode: 0o600 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", txnPrefix], { cwd: scratch }),
    /Managed transaction versions are invalid/i
  );
  assert.equal(server.hits(), 0);
});

test("Shell Installer resets an interrupted managed candidate before bootstrapping", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-recover-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const prefix = path.join(scratch, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "0123456789abcdef0123456789abcdef";
  const oldBytes: Buffer = Buffer.from(releaseStub(INSTALL_PRE_VERSION, target));
  await writeFile(path.join(prefix, "1667"), oldBytes, { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
    id,
    channel: "stable",
    root: prefix,
    target
  }), { mode: 0o600 });
  await writeFile(path.join(prefix, INSTALL_PREVIOUS_FILE + ".next"), oldBytes, { mode: 0o755 });
  await writeFile(path.join(prefix, ".1667-candidate"), "discarded candidate\n", { mode: 0o755 });
  await writeFile(path.join(prefix, ".1667-package.tgz"), "discarded package\n", { mode: 0o600 });
  await writeFile(path.join(prefix, ".1667-install-txn.json"), managedTxn({
    phase: "candidate-ready",
    id,
    root: prefix,
    target,
    activeVersion: INSTALL_PRE_VERSION,
    candidateVersion: INSTALL_VERSION
  }), { mode: 0o600 });

  await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch });
  assert.deepEqual(await readFile(path.join(prefix, INSTALL_PREVIOUS_FILE)), oldBytes);
  await assert.rejects(readFile(path.join(prefix, INSTALL_PREVIOUS_FILE + ".next")));
  await assert.rejects(readFile(path.join(prefix, ".1667-candidate")));
  await assert.rejects(readFile(path.join(prefix, ".1667-package.tgz")));

  const malformedPrefix = path.join(scratch, "malformed-previous");
  await mkdir(malformedPrefix, { mode: 0o755 });
  await chmod(malformedPrefix, 0o755);
  const malformedActive = Buffer.from(releaseStub(INSTALL_VERSION, target));
  const malformedPrevious = Buffer.from(releaseStub(INSTALL_PRE_VERSION, target));
  const malformedOwnership = prettyOwnership({
    id,
    channel: "stable",
    root: malformedPrefix,
    target
  });
  const malformedTxn = managedTxn({
    phase: "ownership-pending",
    id,
    root: malformedPrefix,
    target,
    activeVersion: INSTALL_PRE_VERSION,
    candidateVersion: INSTALL_VERSION
  });
  await writeFile(path.join(malformedPrefix, "1667"), malformedActive, { mode: 0o755 });
  await writeFile(path.join(malformedPrefix, INSTALL_OWNERSHIP_FILE), malformedOwnership, { mode: 0o600 });
  await writeFile(path.join(malformedPrefix, INSTALL_PREVIOUS_FILE + ".next"), malformedPrevious, { mode: 0o755 });
  await mkdir(path.join(malformedPrefix, INSTALL_PREVIOUS_FILE), { mode: 0o700 });
  await writeFile(path.join(malformedPrefix, INSTALL_TRANSACTION_FILE), malformedTxn, { mode: 0o600 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", malformedPrefix], { cwd: scratch }),
    /rollback executable must be a regular/i
  );
  assert.deepEqual(await readFile(path.join(malformedPrefix, "1667")), malformedActive);
  assert.equal(await readFile(path.join(malformedPrefix, INSTALL_OWNERSHIP_FILE), "utf8"), malformedOwnership);
  assert.deepEqual(await readFile(path.join(malformedPrefix, INSTALL_PREVIOUS_FILE + ".next")), malformedPrevious);
  assert.equal((await stat(path.join(malformedPrefix, INSTALL_PREVIOUS_FILE))).isDirectory(), true);
  assert.equal(await readFile(path.join(malformedPrefix, INSTALL_TRANSACTION_FILE), "utf8"), malformedTxn);
  assert.equal(server.hits(), 1);
});

test("Shell Installer clears managed rollback staging during shell recovery", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-shell-recover-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const digests = await writePublishedArchives(archiveDir, INSTALL_VERSION);
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  const prefix = path.join(scratch, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "0123456789abcdef0123456789abcdef";
  const oldBytes = Buffer.from(releaseStub(INSTALL_PRE_VERSION, target));
  await writeFile(path.join(prefix, "1667"), oldBytes, { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), prettyOwnership({
    id,
    channel: "stable",
    root: prefix,
    target
  }), { mode: 0o600 });
  await writeFile(path.join(prefix, INSTALL_PREVIOUS_FILE + ".next"), oldBytes, { mode: 0o755 });
  const archiveName = releaseArchiveFileName(INSTALL_VERSION, target);
  const digest = digests[archiveName];
  if (digest === undefined) throw new Error("host archive digest missing");
  await writeFile(path.join(prefix, INSTALL_TRANSACTION_FILE), canonicalTxnBytes({
    phase: "extracted",
    version: INSTALL_VERSION,
    channel: "beta",
    target,
    digest,
    root: prefix
  }), { mode: 0o600 });

  await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch });
  assert.deepEqual(await readFile(path.join(prefix, INSTALL_PREVIOUS_FILE)), oldBytes);
  await assert.rejects(readFile(path.join(prefix, INSTALL_PREVIOUS_FILE + ".next")));
  assert.equal(server.hits(), 1);
});

test("Shell Installer refuses unmanaged and non-canonical managed state", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const scratch = await createScratch("bootstrap-refuse-");
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archiveDir = path.join(scratch, "archives");
  await mkdir(archiveDir, { recursive: true });
  const server = await serveArchives(archiveDir);
  t.after(server.close);
  const scriptPath = await writeScript(scratch, archiveDir, server.base);
  for (const [label, record] of [
    ["unmanaged", null],
    ["invalid", "{\"schemaVersion\":1,\"product\":\"1667\",\"extra\":true}\n"]
  ] as const) {
    const prefix = path.join(scratch, label);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const oldBytes: Buffer = Buffer.from(releaseStub(INSTALL_PRE_VERSION, target));
    await writeFile(path.join(prefix, "1667"), oldBytes, { mode: 0o755 });
    if (record !== null) {
      await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), record, { mode: 0o600 });
    }
    await assert.rejects(
      execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: scratch }),
      /existing 1667|canonical|Ownership Record/i
    );
    assert.deepEqual(await readFile(path.join(prefix, "1667")), oldBytes, label + " active must survive");
  }
  const oversizedPrefix = path.join(scratch, "oversized-transaction");
  await mkdir(oversizedPrefix, { mode: 0o755 });
  await chmod(oversizedPrefix, 0o755);
  const oversizedTxn = Buffer.alloc(16_385, 0x78);
  await writeFile(path.join(oversizedPrefix, INSTALL_TRANSACTION_FILE), oversizedTxn, { mode: 0o600 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", oversizedPrefix], { cwd: scratch }),
    /Transaction Record is too large/i
  );
  assert.deepEqual(await readFile(path.join(oversizedPrefix, INSTALL_TRANSACTION_FILE)), oversizedTxn);
  assert.equal(server.hits(), 0);
});
