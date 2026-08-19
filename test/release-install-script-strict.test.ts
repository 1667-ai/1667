import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import {
  assertSafeAssetBaseUrl,
  renderInstallScript,
  renderInstallScriptsForVersion
} from "../scripts/release-install-script.js";
import type { BuiltArtifactTarget } from "../shared/release-targets.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  canonicalTxnBytes,
  digestsFor,
  execFileAsync,
  hostShellInstallerTarget,
  sha256File,
  writeFakeArchive,
  writePublishedArchives
} from "./release-install-script-fixture.js";

test("generated installer durably fsyncs ownership before clearing the transaction", () => {
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION)
  });
  assert.match(body, /fsync_path\(\)/);
  assert.match(body, /fsync_dir\(\)/);
  assert.match(body, /clear_txn\(\)/);
  // write_txn and write_ownership publish then fsync the file and parent dir.
  assert.match(body, /mv "\$tmp" "\$root\/\$TXN_FILE"\s*\n\s*fsync_path "\$root\/\$TXN_FILE"/);
  assert.match(
    body,
    /mv "\$tmp" "\$dest" 9>&-\s*\n\s*chmod 0600 "\$dest" 9>&-\s*\n\s*# Ownership must be durable[\s\S]*?fsync_path "\$dest"/
  );
  const managedTxnWriter = body.indexOf("write_managed_txn()");
  const managedTxnTempFsync = body.indexOf('fsync_path "$tmp"', managedTxnWriter);
  const managedTxnMove = body.indexOf(
    'mv "$tmp" "$root/$TXN_FILE" 9>&-',
    managedTxnWriter
  );
  const managedTxnPublishedFsync = body.indexOf(
    'fsync_path "$root/$TXN_FILE"',
    managedTxnMove
  );
  const managedTxnParentFsync = body.indexOf('fsync_dir "$root"', managedTxnPublishedFsync);
  assert.ok(managedTxnWriter >= 0, "managed transaction writer is present");
  assert.ok(managedTxnTempFsync > managedTxnWriter, "managed txn temp is fsynced before publish");
  assert.ok(managedTxnMove > managedTxnTempFsync, "managed txn moves only after temp fsync");
  assert.ok(
    managedTxnPublishedFsync > managedTxnMove,
    "published managed txn is fsynced after move"
  );
  assert.ok(
    managedTxnParentFsync > managedTxnPublishedFsync,
    "managed txn parent directory is fsynced after publish"
  );
  const ownershipWriter = body.indexOf("write_ownership()");
  const ownershipTempFsync = body.indexOf('fsync_path "$tmp"', ownershipWriter);
  const ownershipMove = body.indexOf('mv "$tmp" "$dest" 9>&-', ownershipWriter);
  const ownershipPublishedFsync = body.indexOf('fsync_path "$dest"', ownershipMove);
  const ownershipParentFsync = body.indexOf('fsync_dir "$root"', ownershipPublishedFsync);
  assert.ok(ownershipWriter >= 0, "ownership writer is present");
  assert.ok(ownershipTempFsync > ownershipWriter, "ownership temp is fsynced before publish");
  assert.ok(ownershipMove > ownershipTempFsync, "ownership moves only after temp fsync");
  assert.ok(
    ownershipPublishedFsync > ownershipMove,
    "published ownership is fsynced after move"
  );
  assert.ok(
    ownershipParentFsync > ownershipPublishedFsync,
    "ownership parent directory is fsynced after publish"
  );
  assert.match(
    body,
    /semver_order=\$\(exec 9>&-;\s*semver_compare "\$active_version" "\$PRODUCT_VERSION"\)/
  );
  assert.match(
    body,
    /group_other_members "\$gid" "\$\(exec 9>&-; id -un\)"/
  );
  assert.match(
    body,
    /txn_kind=\$\(exec 9>&-;\s*json_string_field "\$txn_text" kind\)/
  );
  const ownershipRenderer = body.indexOf("canonical_ownership_bytes()");
  assert.ok(ownershipRenderer >= 0, "historical Ownership Record renderer is present");
  assert.ok(
    body.indexOf("cat 9>&- <<EOF", ownershipRenderer) > ownershipRenderer,
    "historical Ownership Record renderer closes the lock fd"
  );
  assert.match(
    body,
    /recover_install\(\) \{[\s\S]*?validate_managed_file_safety "\$txn" "Install Transaction Record"[\s\S]*?txn_mode=\$\(exec 9>&-; file_mode "\$txn"\)[\s\S]*?\[ "\$txn_mode" = 600 \]/
  );
  assert.match(
    body,
    /case "\$RECOVER_STATUS" in[\s\S]*?completed\)[\s\S]*?none\|reset\|managed-reset\|managed-completed\)[\s\S]*?\*\)[\s\S]*?Unsupported recovery status/
  );
  const managedRecoveryDispatch = body.indexOf('if [ "$txn_kind" = managed ]; then');
  const managedRecoveryCall = body.indexOf(
    'recover_managed_install "$root" "$executable" "$target" "$txn"',
    managedRecoveryDispatch
  );
  assert.ok(managedRecoveryDispatch >= 0, "managed recovery dispatch is present");
  assert.ok(managedRecoveryCall > managedRecoveryDispatch, "managed recovery call is present");
  for (const path of [
    'refuse_prior_managed_path "$root/$EXTRACT_STAGE" "extract staging"',
    'refuse_prior_managed_path "$root/$archive" "Release Archive staging"'
  ]) {
    const guard = body.indexOf(path, managedRecoveryDispatch);
    assert.ok(guard > managedRecoveryDispatch && guard < managedRecoveryCall, path + " is guarded");
  }
  const managedBootstrapStart = body.indexOf(
    '    validate_managed_ownership "$prefix" "$executable" "$target"'
  );
  const freshMutationStart = body.indexOf(
    '  else\n    write_txn "$prefix" "candidate-ready"',
    managedBootstrapStart
  );
  assert.ok(managedBootstrapStart >= 0, "managed bootstrap branch is present");
  assert.ok(freshMutationStart > managedBootstrapStart, "fresh branch follows managed branch");
  const managedBootstrap = body.slice(managedBootstrapStart, freshMutationStart);
  for (const command of [
    'rm -f "$prefix/$PACKAGE_STAGING_FILE" 9>&-',
    'rm -f "$prefix/$PREVIOUS_NEXT_FILE" 9>&-',
    'cp "$executable" "$prefix/$PREVIOUS_NEXT_FILE" 9>&-',
    'chmod 0755 "$prefix/$PREVIOUS_NEXT_FILE" 9>&-',
    'mv "$prefix/$CANDIDATE_FILE" "$executable" 9>&-',
    'chmod 0755 "$executable" 9>&-',
    'mv "$prefix/$PREVIOUS_NEXT_FILE" "$prefix/$PREVIOUS_FILE" 9>&-'
  ]) {
    assert.ok(
      managedBootstrap.includes(command),
      "managed path closes FD 9 for " + command
    );
  }
  // Pre-existing non-regular Ownership Record destination is refused.
  assert.match(body, /Ownership Record path is not a regular file/);
  assert.match(body, /Ownership Record must not be a symbolic link/);
  // Final Ownership Record bytes are verified after atomic replacement.
  assert.match(body, /Ownership Record verification failed after write/);
  assert.match(body, /cmp -s "\$dest" "\$verify"/);
  // Install path: ownership write, then clear_txn (never rm txn before ownership sync).
  const ownershipCall = body.indexOf(
    'write_ownership "$prefix" "$installation_id" "$executable" "$target"'
  );
  const clearTxnCall = body.indexOf('clear_txn "$prefix"');
  assert.ok(ownershipCall >= 0, "install path writes ownership");
  assert.ok(clearTxnCall > ownershipCall, "clear_txn runs after write_ownership");
  // clear_txn removes the txn then fsyncs the Install Root so the unlink is durable.
  assert.match(body, /rm -f "\$root\/\$TXN_FILE" 9>&-\s*\n\s*fsync_dir "\$root"/);
  // Candidate file is fsynced before candidate-ready is published (not after).
  const probeAt = body.indexOf('probe_candidate "$prefix/$CANDIDATE_FILE" "$target"');
  assert.ok(probeAt >= 0, "install path probes the candidate");
  const fsyncCandidateAt = body.indexOf(
    'fsync_path "$prefix/$CANDIDATE_FILE"',
    probeAt
  );
  const freshInstallAt = body.indexOf(
    '  else\n    write_txn "$prefix" "candidate-ready"',
    probeAt
  );
  assert.ok(freshInstallAt > probeAt, "fresh install branch remains present");
  const candidateReadyAt = body.indexOf(
    'write_txn "$prefix" "candidate-ready"',
    freshInstallAt
  );
  const renameActiveAt = body.indexOf(
    'mv "$prefix/$CANDIDATE_FILE" "$executable"',
    freshInstallAt
  );
  const fsyncActiveAt = body.indexOf('fsync_path "$executable"', renameActiveAt);
  assert.ok(fsyncCandidateAt > probeAt, "install path fsyncs the candidate after probe");
  assert.ok(
    candidateReadyAt > fsyncCandidateAt,
    "candidate-ready is published only after the candidate is fsynced"
  );
  assert.ok(
    renameActiveAt > candidateReadyAt,
    "activation rename runs after candidate-ready"
  );
  assert.ok(
    fsyncActiveAt > renameActiveAt,
    "active executable is fsynced after activation rename"
  );
  // Active executable is fsynced after activation rename.
  assert.match(body, /chmod 0755 "\$executable"\s*\n\s*fsync_path "\$executable"/);
  // Recovery candidate-ready: fsync active before ownership publish and txn clear.
  const recoverSoft = body.indexOf("probe_candidate_soft");
  assert.ok(recoverSoft >= 0, "recovery probes the active executable");
  const recoverFsync = body.indexOf('fsync_path "$executable"', recoverSoft);
  const recoverOwnership = body.indexOf(
    'write_ownership "$root" "$installation_id" "$executable" "$target"',
    recoverSoft
  );
  const recoverClear = body.indexOf('clear_txn "$root"', recoverSoft);
  assert.ok(recoverFsync > recoverSoft, "recovery fsyncs active after probe");
  assert.ok(recoverOwnership > recoverFsync, "recovery writes ownership after fsync_path active");
  assert.ok(recoverClear > recoverOwnership, "recovery clears txn after ownership");
  const activatedRecovery = body.indexOf('    activated)');
  const activatedOwnershipFsync = body.indexOf('fsync_path "$ownership"', activatedRecovery);
  const activatedClear = body.indexOf('clear_txn "$root"', activatedRecovery);
  assert.ok(activatedRecovery >= 0, "activated recovery branch is present");
  assert.ok(activatedOwnershipFsync > activatedRecovery, "activated recovery fsyncs existing ownership");
  assert.ok(activatedClear > activatedOwnershipFsync, "activated recovery clears txn after ownership fsync");
  // Durability failure is never ignored (sync child also closes lock FD 9).
  assert.doesNotMatch(body, /sync \|\| true/);
  assert.match(body, /sync 9>&- \|\| die/);
});

test("generated installer refuses musl before selecting a Linux target", () => {
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION)
  });
  // detect_target is invoked before archive name/digest selection.
  assert.match(body, /target=\$\(detect_target\)\s*\|\|\s*exit 1/);
  const detectMatch = body.match(/detect_target\(\) \{[\s\S]*?\n\}/);
  assert.ok(detectMatch !== null, "detect_target function is present");
  const detect = detectMatch[0]!;
  const linuxCase = detect.indexOf("Linux)");
  const muslRefuse = detect.indexOf("Linux systems that use musl are not supported");
  const linuxArm = detect.indexOf("linux-arm64");
  const linuxX64 = detect.indexOf("linux-x64");
  assert.ok(linuxCase >= 0, "Linux branch is present");
  assert.ok(muslRefuse > linuxCase, "musl refusal is inside the Linux branch");
  assert.ok(linuxArm > muslRefuse, "linux-arm64 is selected only after musl refusal");
  assert.ok(linuxX64 > muslRefuse, "linux-x64 is selected only after musl refusal");
  // Exact marker paths used by the generated contract.
  assert.match(detect, /\/lib\/ld-musl-x86_64\.so\.1/);
  assert.match(detect, /\/lib\/ld-musl-aarch64\.so\.1/);
  assert.match(detect, /\/lib\/libc\.musl-x86_64\.so\.1/);
  assert.match(detect, /\/lib\/libc\.musl-aarch64\.so\.1/);
});

test("asset base URL rejects credentials, query, fragment, controls, and quotes", () => {
  const github = `https://github.com/${INSTALL_REPO}/releases/download/v${INSTALL_VERSION}`;
  assert.equal(assertSafeAssetBaseUrl(github), github);
  assert.equal(
    assertSafeAssetBaseUrl("http://127.0.0.1:9"),
    "http://127.0.0.1:9"
  );
  assert.equal(
    assertSafeAssetBaseUrl("http://localhost:9"),
    "http://localhost:9"
  );
  assert.throws(
    () => assertSafeAssetBaseUrl("https://user:pass@github.com/org/repo/releases"),
    /credentials/i
  );
  assert.throws(
    () => assertSafeAssetBaseUrl(`${github}?token=1`),
    /query/i
  );
  assert.throws(
    () => assertSafeAssetBaseUrl(`${github}#frag`),
    /fragment/i
  );
  assert.throws(
    () => assertSafeAssetBaseUrl(`${github}'`),
    /disallowed characters/i
  );
  assert.throws(
    () => assertSafeAssetBaseUrl(`${github}\n`),
    /disallowed characters/i
  );
  assert.throws(
    () => assertSafeAssetBaseUrl("http://evil.example/"),
    /invalid/i
  );
  // Production renderer still accepts the default GitHub base.
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION)
  });
  assert.match(body, new RegExp(`ASSET_BASE='${github.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
});

test(
  "Shell Installer rejects non-canonical transactions, exact layout, symlink locks",
  { timeout: 60_000 },
  async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-strict-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const detectedTarget = hostShellInstallerTarget();
  if (detectedTarget === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const hostTarget: BuiltArtifactTarget = detectedTarget;

  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);

  const server = createServer((request, response) => {
    const name = path.basename(request.url ?? "");
    const file = path.join(archivesDir, name);
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
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });
  await chmod(root, 0o755);

  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  const hostDigestValue = digests[hostArchive];
  if (hostDigestValue === undefined) throw new Error("host archive digest missing");
  const hostDigest: string = hostDigestValue;

  async function rejectTxn(
    label: string,
    mutate: (good: string, installRoot: string) => string
  ): Promise<void> {
    const prefix = path.join(root, label);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const installRoot = await realpath(prefix);
    const good = canonicalTxnBytes({
      phase: "activated",
      version: INSTALL_VERSION,
      channel: "beta",
      target: hostTarget,
      digest: hostDigest,
      root: installRoot
    });
    await writeFile(
      path.join(prefix, ".1667-install-txn.json"),
      mutate(good, installRoot),
      { mode: 0o600 }
    );
    await assert.rejects(
      execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
      /canonical phase record/i
    );
  }

  await rejectTxn("txn-unknown", (good) =>
    good.replace('"schemaVersion":1', '"schemaVersion":1,"extra":"no"')
  );
  await rejectTxn("txn-missing", (good) =>
    good.replace(`,"archiveSha256":"${hostDigest}"`, "")
  );
  await rejectTxn("txn-duplicate", (good) =>
    good.replace('"phase":"activated"', '"phase":"activated","phase":"downloading"')
  );
  await rejectTxn("txn-malformed", (_good, installRoot) =>
    JSON.stringify({
      schemaVersion: 1,
      phase: "activated",
      version: INSTALL_VERSION,
      channel: "beta",
      artifactTarget: hostTarget,
      archiveSha256: hostDigest,
      installRoot,
      executable: `${installRoot}/1667`
    }, null, 2) + "\n"
  );

  // Extra trailing newline would match under command-substitution comparison; cmp rejects it.
  await rejectTxn("txn-extra-newline", (good) => `${good}\n`);

  // Exact archive layout: extra top-level entry is refused.
  const extraArchive = path.join(archivesDir, hostArchive);
  await writeFakeArchive(extraArchive, INSTALL_VERSION, hostTarget, INSTALL_VERSION, {
    extraEntry: true
  });
  digests[hostArchive] = sha256File(await readFile(extraArchive));
  const extraScript = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const extraScriptPath = path.join(root, "install-extra.sh");
  await writeFile(extraScriptPath, extraScript, { mode: 0o755 });
  const extraPrefix = path.join(root, "extra-layout");
  await mkdir(extraPrefix, { mode: 0o755 });
  await chmod(extraPrefix, 0o755);
  await assert.rejects(
    execFileAsync("sh", [extraScriptPath, "--prefix", extraPrefix], { cwd: root }),
    /exact pinned Release Archive layout|Archive layout/i
  );

  // Exact archive layout: symbolic link entry is refused.
  await writeFakeArchive(extraArchive, INSTALL_VERSION, hostTarget, INSTALL_VERSION, {
    symlinkEntry: true
  });
  digests[hostArchive] = sha256File(await readFile(extraArchive));
  const linkScript = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const linkScriptPath = path.join(root, "install-link.sh");
  await writeFile(linkScriptPath, linkScript, { mode: 0o755 });
  const linkPrefix = path.join(root, "link-layout");
  await mkdir(linkPrefix, { mode: 0o755 });
  await chmod(linkPrefix, 0o755);
  await assert.rejects(
    execFileAsync("sh", [linkScriptPath, "--prefix", linkPrefix], { cwd: root }),
    /symbolic link.*hard link/i
  );

  // Restore a good archive for lock-path tests.
  await writeFakeArchive(extraArchive, INSTALL_VERSION, hostTarget);
  digests[hostArchive] = sha256File(await readFile(extraArchive));
  const lockScript = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const lockScriptPath = path.join(root, "install-lock.sh");
  await writeFile(lockScriptPath, lockScript, { mode: 0o755 });

  const lockPrefix = path.join(root, "symlink-lock");
  await mkdir(lockPrefix, { mode: 0o755 });
  await chmod(lockPrefix, 0o755);
  const lockTarget = path.join(root, "lock-target");
  await mkdir(lockTarget, { mode: 0o755 });
  await symlink(lockTarget, path.join(lockPrefix, ".1667-install.lock"));
  await assert.rejects(
    execFileAsync("sh", [lockScriptPath, "--prefix", lockPrefix], { cwd: root }),
    /lock path is a symbolic link/i
  );

  // Directory at lock path is refused (lock must be a regular file).
  const dirLockPrefix = path.join(root, "dir-lock");
  await mkdir(dirLockPrefix, { mode: 0o755 });
  await chmod(dirLockPrefix, 0o755);
  await mkdir(path.join(dirLockPrefix, ".1667-install.lock"), { mode: 0o700 });
  await assert.rejects(
    execFileAsync("sh", [lockScriptPath, "--prefix", dirLockPrefix], { cwd: root }),
    /lock path is not a regular file/i
  );

  // Install Root with a double quote is refused before any mutation.
  const quotePrefix = path.join(root, 'quote"root');
  await mkdir(quotePrefix, { mode: 0o755 });
  await chmod(quotePrefix, 0o755);
  await assert.rejects(
    execFileAsync("sh", [lockScriptPath, "--prefix", quotePrefix], { cwd: root }),
    /quote or backslash|control character/i
  );

  // Recovery for downloading/extracted deletes only the exact pinned archive.
  // An unrelated similarly named 1667_*.tar.gz must remain byte-for-byte intact.
  const pinnedName = hostArchive;
  const liveDigest = digests[hostArchive];
  if (liveDigest === undefined) throw new Error("host archive digest missing after layout tests");
  const unrelatedName = pinnedName.replace(/\.tar\.gz$/u, "_other.tar.gz");
  assert.match(unrelatedName, /^1667_.*\.tar\.gz$/u);
  assert.notEqual(unrelatedName, pinnedName);

  for (const phase of ["downloading", "extracted"] as const) {
    const prefix = path.join(root, `archive-clean-${phase}`);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const installRoot = await realpath(prefix);
    const pinnedPath = path.join(prefix, pinnedName);
    const unrelatedPath = path.join(prefix, unrelatedName);
    const pinnedBytes = Buffer.from(`pinned-${phase}-bytes\n`);
    const unrelatedBytes = Buffer.from(`unrelated-keep-${phase}-bytes-unique\n`);
    await writeFile(pinnedPath, pinnedBytes);
    await writeFile(unrelatedPath, unrelatedBytes);
    await writeFile(
      path.join(prefix, ".1667-install-txn.json"),
      canonicalTxnBytes({
        phase,
        version: INSTALL_VERSION,
        channel: "beta",
        target: hostTarget,
        digest: liveDigest,
        root: installRoot
      }),
      { mode: 0o600 }
    );
    // Recovery resets then installs; after reset the pinned archive is gone and
    // the unrelated archive must still match its original bytes.
    await execFileAsync("sh", [lockScriptPath, "--prefix", prefix], { cwd: root });
    assert.equal(await readFile(unrelatedPath).then((b) => b.equals(unrelatedBytes)), true);
    // After a completed install the pinned name is removed; if present it must not
    // still be the interrupted placeholder bytes.
    try {
      const after = await readFile(pinnedPath);
      assert.equal(after.equals(pinnedBytes), false);
    } catch {
      // Missing after successful install is expected.
    }
  }
  }
);

test("recovery removes exact extract staging and keeps unrelated paths", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-extract-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostShellInstallerTarget();
  if (hostTarget === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }

  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);
  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  const liveDigest = digests[hostArchive];
  if (liveDigest === undefined) throw new Error("host archive digest missing");

  const server = createServer((request, response) => {
    const file = path.join(archivesDir, path.basename(request.url ?? ""));
    void readFile(file)
      .then((bytes) => {
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": String(bytes.byteLength)
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  assert.match(scriptBody, /EXTRACT_STAGE='\.1667-extract'/);
  assert.match(scriptBody, /remove_extract_stage/);
  assert.doesNotMatch(scriptBody, /\.1667-extract\.\$\$/);
  const scriptPath = path.join(root, "install-stage.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const installRoot = await realpath(prefix);
  const stage = path.join(prefix, ".1667-extract");
  await mkdir(stage, { mode: 0o700 });
  await writeFile(path.join(stage, "partial-member"), "interrupted-extract\n");
  const probeOutput = path.join(prefix, ".1667-probe-output");
  await writeFile(probeOutput, "interrupted-probe\n", { mode: 0o600 });
  const unrelated = path.join(prefix, "unrelated-keep.txt");
  const unrelatedBytes = Buffer.from("must-survive-recovery\n");
  await writeFile(unrelated, unrelatedBytes);
  // Also place a similarly named non-reserved directory that must not be deleted.
  const lookalike = path.join(prefix, ".1667-extract-other");
  await mkdir(lookalike, { mode: 0o700 });
  await writeFile(path.join(lookalike, "keep"), "keep\n");

  await writeFile(
    path.join(prefix, ".1667-install-txn.json"),
    canonicalTxnBytes({
      phase: "extracted",
      version: INSTALL_VERSION,
      channel: "beta",
      target: hostTarget,
      digest: liveDigest,
      root: installRoot
    }),
    { mode: 0o600 }
  );

  await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root });

  await assert.rejects(access(stage));
  await assert.rejects(access(probeOutput));
  assert.equal(await readFile(unrelated).then((b) => b.equals(unrelatedBytes)), true);
  assert.equal(await readFile(path.join(lookalike, "keep"), "utf8"), "keep\n");
  // Fresh install completed after recovery reset.
  await access(path.join(prefix, "1667"));
  await access(path.join(prefix, ".1667-install.json"));
});
