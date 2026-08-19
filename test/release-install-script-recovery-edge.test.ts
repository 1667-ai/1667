import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  INSTALL_PREVIOUS_FILE,
  INSTALL_TRANSACTION_FILE
} from "../shared/install-layout.js";
import {
  INSTALL_OWNERSHIP_FILE,
  parseInstallOwnershipRecordText
} from "../shared/install-ownership-record.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import { serializeInstallTransactionRecord } from "../tui/src/install-transaction-record.js";
import {
  INSTALL_PRE_VERSION,
  INSTALL_REPO,
  INSTALL_VERSION,
  canonicalTxnBytes,
  execFileAsync,
  hostShellInstallerTarget,
  releaseStub,
  writePublishedArchives
} from "./release-install-script-fixture.js";

async function createScratch(label: string): Promise<string> {
  const parent = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  return await mkdtemp(path.join(parent, label));
}

function compactOwnership(input: {
  readonly id: string;
  readonly channel?: "stable" | "beta";
  readonly root: string;
  readonly target: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    product: "1667",
    installationId: input.id,
    method: "shell",
    channel: input.channel ?? "beta",
    installRoot: input.root,
    executable: input.root + "/1667",
    artifactTarget: input.target
  }) + "\n";
}

function managedTxn(input: {
  readonly id: string;
  readonly root: string;
  readonly target: BuiltArtifactTarget;
}): string {
  return serializeInstallTransactionRecord({
    kind: "managed",
    schemaVersion: 1,
    operation: "upgrade",
    channel: "beta",
    updateChannel: true,
    activeVersion: INSTALL_PRE_VERSION,
    candidateVersion: INSTALL_VERSION,
    installationId: input.id,
    installRoot: input.root,
    executable: input.root + "/1667",
    artifactTarget: input.target,
    phase: "ownership-pending"
  });
}

async function writeScript(root: string): Promise<{
  readonly scriptPath: string;
  readonly digest: string;
}> {
  const archives = path.join(root, "archives");
  const digests = await writePublishedArchives(archives, INSTALL_VERSION);
  const target = hostShellInstallerTarget();
  if (target === null) throw new Error("host cannot run the POSIX Shell Installer");
  const archive = releaseArchiveFileName(INSTALL_VERSION, target);
  const digest = digests[archive];
  if (digest === undefined) throw new Error("host archive digest missing");
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: "http://127.0.0.1:1"
  })["install-beta.sh"]!, { mode: 0o755 });
  return { scriptPath, digest };
}

test("activated recovery preserves valid ownership and rejects malformed ownership", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const root = await createScratch("install-recovery-ownership-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { scriptPath, digest } = await writeScript(root);
  const id = "0123456789abcdef0123456789abcdef";
  const cases = [
    { label: "valid", record: "valid" },
    { label: "channel-mismatch", record: "channel-mismatch" },
    { label: "malformed", record: "malformed" },
    { label: "dangling", record: "dangling" }
  ] as const;
  for (const item of cases) {
    const prefix = path.join(root, item.label);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const active: Buffer = Buffer.from(releaseStub(INSTALL_VERSION, target));
    const txn = canonicalTxnBytes({
      phase: "activated",
      version: INSTALL_VERSION,
      channel: "beta",
      target,
      digest,
      root: prefix
    });
    await writeFile(path.join(prefix, "1667"), active, { mode: 0o755 });
    await writeFile(path.join(prefix, INSTALL_TRANSACTION_FILE), txn, { mode: 0o600 });
    const ownership = compactOwnership({
      id,
      channel: item.record === "channel-mismatch" ? "stable" : "beta",
      root: prefix,
      target
    });
    if (item.record === "dangling") {
      await symlink("missing-ownership", path.join(prefix, INSTALL_OWNERSHIP_FILE));
    } else {
      await writeFile(
        path.join(prefix, INSTALL_OWNERSHIP_FILE),
        item.record === "malformed" ? "{\"schemaVersion\":1}\n" : ownership,
        { mode: 0o600 }
      );
    }

    if (item.record === "valid") {
      await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root });
      const recovered = parseInstallOwnershipRecordText(
        await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8")
      );
      assert.equal(recovered.installationId, id);
      assert.equal(await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8"), ownership);
      await assert.rejects(readFile(path.join(prefix, INSTALL_TRANSACTION_FILE)));
    } else {
      await assert.rejects(
        execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
        item.record === "channel-mismatch"
          ? /Ownership Record channel does not match/i
          : /Ownership Record|symbolic link|canonical/i
      );
      assert.deepEqual(await readFile(path.join(prefix, "1667")), active);
      assert.equal(await readFile(path.join(prefix, INSTALL_TRANSACTION_FILE), "utf8"), txn);
      const ownershipStat = await lstat(path.join(prefix, INSTALL_OWNERSHIP_FILE));
      assert.equal(ownershipStat.isSymbolicLink(), item.record === "dangling");
    }
  }
});

test("Shell Installer refuses a dangling transaction record", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const root = await createScratch("install-recovery-txn-link-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { scriptPath } = await writeScript(root);
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const txnPath = path.join(prefix, INSTALL_TRANSACTION_FILE);
  await symlink("missing-transaction", txnPath);
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
    /Install transaction must not be a symbolic link/i
  );
  assert.equal((await lstat(txnPath)).isSymbolicLink(), true);
});

test("Managed recovery refuses dangling rollback staging before fallback", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const root = await createScratch("install-recovery-previous-link-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { scriptPath } = await writeScript(root);
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const id = "fedcba9876543210fedcba9876543210";
  const active = Buffer.from(releaseStub(INSTALL_VERSION, target));
  const previous = Buffer.from(releaseStub(INSTALL_PRE_VERSION, target));
  const ownership = compactOwnership({ id, root: prefix, target });
  const txn = managedTxn({ id, root: prefix, target });
  await writeFile(path.join(prefix, "1667"), active, { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), ownership, { mode: 0o600 });
  await writeFile(path.join(prefix, INSTALL_PREVIOUS_FILE), previous, { mode: 0o755 });
  const previousNext = path.join(prefix, INSTALL_PREVIOUS_FILE + ".next");
  await symlink("missing-previous", previousNext);
  await writeFile(path.join(prefix, INSTALL_TRANSACTION_FILE), txn, { mode: 0o600 });

  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
    /rollback staging is invalid|regular/i
  );
  assert.deepEqual(await readFile(path.join(prefix, "1667")), active);
  assert.equal(await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8"), ownership);
  assert.deepEqual(await readFile(path.join(prefix, INSTALL_PREVIOUS_FILE)), previous);
  assert.equal(await readFile(path.join(prefix, INSTALL_TRANSACTION_FILE), "utf8"), txn);
  assert.equal((await lstat(previousNext)).isSymbolicLink(), true);
});
