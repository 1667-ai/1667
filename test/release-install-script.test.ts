import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import {
  installScriptChannelsForVersion,
  installScriptFileName,
  renderInstallScript,
  renderInstallScriptsForVersion
} from "../scripts/release-install-script.js";
import { parseInstallOwnershipRecordText } from "../shared/install-ownership-record.js";
import {
  INSTALL_PRE_VERSION,
  INSTALL_REPO,
  INSTALL_VERSION,
  canonicalTxnBytes,
  digestsFor,
  execFileAsync,
  hostPublishedTarget,
  ptyCommand,
  releaseStub,
  sha256File,
  writeFakeArchive,
  writePublishedArchives
} from "./release-install-script-fixture.js";

test("install script channels require stable only for non-prerelease versions", () => {
  assert.deepEqual(installScriptChannelsForVersion(INSTALL_VERSION), ["beta", "stable"]);
  assert.deepEqual(installScriptChannelsForVersion(INSTALL_PRE_VERSION), ["beta"]);
  assert.equal(installScriptFileName("beta"), "install-beta.sh");
  assert.throws(
    () => renderInstallScript({
      version: INSTALL_PRE_VERSION,
      channel: "stable",
      repository: INSTALL_REPO,
      archives: digestsFor(INSTALL_PRE_VERSION)
    }),
    /non-prerelease/u
  );
});

test("generated install scripts embed exact digests and never resolve latest", () => {
  const archives = digestsFor(INSTALL_VERSION);
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives
  });
  assert.match(body, /^#!\/bin\/sh\n/u);
  assert.match(body, new RegExp(`PRODUCT_VERSION='${INSTALL_VERSION}'`));
  assert.match(body, /INSTALL_CHANNEL='beta'/);
  assert.match(body, /command -v curl/);
  assert.doesNotMatch(body, /wget/);
  assert.doesNotMatch(body, /latest/i);
  assert.doesNotMatch(body, /dist-tags/);
  // Both URL branches embed portable connect and overall transfer deadlines.
  assert.match(body, /DOWNLOAD_CONNECT_TIMEOUT_SEC=30/);
  assert.match(body, /DOWNLOAD_MAX_TIME_SEC=600/);
  assert.match(body, /--connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC"/);
  assert.match(body, /--max-time "\$DOWNLOAD_MAX_TIME_SEC"/);
  const httpsBranch = body.match(
    /https:\/\/\*\)[\s\S]*?curl[\s\S]*?--connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC"[\s\S]*?--max-time "\$DOWNLOAD_MAX_TIME_SEC"[\s\S]*?;;/
  );
  assert.ok(httpsBranch !== null, "HTTPS curl branch has connect and max-time bounds");
  const loopbackBranch = body.match(
    /http:\/\/127\.0\.0\.1:\*\|http:\/\/localhost:\*\)[\s\S]*?curl[\s\S]*?--connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC"[\s\S]*?--max-time "\$DOWNLOAD_MAX_TIME_SEC"[\s\S]*?;;/
  );
  assert.ok(loopbackBranch !== null, "loopback curl branch has connect and max-time bounds");
  // The HTTPS branch must keep failing closed and must never follow a redirect
  // off HTTPS. The digest check would catch wrong bytes, but not the correct
  // bytes fetched over plaintext. Pin the flags so an edit to this line cannot
  // drop them silently.
  assert.match(httpsBranch![0], /curl -fSL /u);
  assert.match(httpsBranch![0], /--proto '=https'/u);
  assert.match(httpsBranch![0], /--proto-redir '=https'/u);
  assert.match(loopbackBranch![0], /curl -fSL /u);
  // The transfer bar is for a person at a terminal. A pipe or a log gets
  // silence, so captured output keeps no carriage returns.
  assert.match(body, /if \[ -t 2 \]; then\n\s+progress='--progress-bar'\n\s+else\n\s+progress='--silent'/u);
  assert.match(httpsBranch![0], /"\$progress"/u);
  assert.match(loopbackBranch![0], /"\$progress"/u);
  // Every accepted --prefix must be able to produce a canonical Ownership Record.
  assert.match(body, /prefix must not be the filesystem root/);
  for (const archive of archives) {
    assert.match(body, new RegExp(archive.fileName.replace(/\./g, "\\.")));
    assert.match(body, new RegExp(archive.sha256));
  }
  const scripts = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests: Object.fromEntries(archives.map((a) => [a.fileName, a.sha256]))
  });
  assert.deepEqual(Object.keys(scripts).sort(), ["install-beta.sh", "install-stable.sh"]);
});

test("Shell Installer rejects filesystem root --prefix before dry-run", async (t) => {
  // dry-run only: proves rejection without any Install Root mutation at /.
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-prefix-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION),
    assetBaseUrl: "http://127.0.0.1:9"
  });
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, body, { mode: 0o755 });

  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", "/", "--dry-run"], { cwd: root }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const extra = error as Error & { stderr?: string | Buffer };
      const stderr = typeof extra.stderr === "string"
        ? extra.stderr
        : Buffer.isBuffer(extra.stderr)
          ? extra.stderr.toString("utf8")
          : "";
      const text = `${error.message}\n${stderr}`;
      return /filesystem root/i.test(text);
    }
  );
  // Also reject the equals form; still dry-run only.
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix=/", "--dry-run"], { cwd: root }),
    /filesystem root/i
  );
});

test("Shell Installer rejects empty --prefix forms and keeps default without flag", async (t) => {
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-prefix-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION),
    assetBaseUrl: "http://127.0.0.1:9"
  });
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, body, { mode: 0o755 });

  const rejectEmpty = async (args: string[]): Promise<void> => {
    await assert.rejects(
      execFileAsync("sh", [scriptPath, ...args], { cwd: root }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const extra = error as Error & { stderr?: string | Buffer };
        const stderr = typeof extra.stderr === "string"
          ? extra.stderr
          : Buffer.isBuffer(extra.stderr)
            ? extra.stderr.toString("utf8")
            : "";
        return /--prefix requires an absolute path/i.test(`${error.message}\n${stderr}`);
      }
    );
  };
  await rejectEmpty(["--prefix", "", "--dry-run"]);
  await rejectEmpty(["--prefix=", "--dry-run"]);

  // No --prefix still selects the default install root (dry-run only).
  const { stdout } = await execFileAsync("sh", [scriptPath, "--dry-run"], { cwd: root });
  assert.match(stdout, new RegExp(`${homedir()}/\\.local/bin`));
});

test("Shell Installer rejects directory Ownership Record destination and verifies final record", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-own-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

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

  const scripts = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  });
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scripts["install-beta.sh"]!, { mode: 0o755 });

  // Pre-existing directory at the Ownership Record path must fail closed before
  // download. Fresh install does not delete prior managed state.
  const dirPrefix = path.join(root, "dir-own-prefix");
  await mkdir(dirPrefix, { mode: 0o755 });
  await chmod(dirPrefix, 0o755);
  const ownershipDir = path.join(dirPrefix, ".1667-install.json");
  await mkdir(ownershipDir, { mode: 0o700 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", dirPrefix], { cwd: root }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const extra = error as Error & { stderr?: string | Buffer };
      const stderr = typeof extra.stderr === "string"
        ? extra.stderr
        : Buffer.isBuffer(extra.stderr)
          ? extra.stderr.toString("utf8")
          : "";
      return /prior managed state.*Ownership Record/i.test(`${error.message}\n${stderr}`);
    }
  );
  const dirStat = await stat(ownershipDir);
  assert.equal(dirStat.isDirectory(), true);
  await assert.rejects(access(path.join(dirPrefix, "1667")));

  // Happy path: final Ownership Record is a regular file and parses as schema.
  const okPrefix = path.join(root, "ok-own-prefix");
  await mkdir(okPrefix, { mode: 0o755 });
  await chmod(okPrefix, 0o755);
  const { stdout } = await execFileAsync("sh", [scriptPath, "--prefix", okPrefix], {
    cwd: root
  });
  assert.match(stdout, new RegExp(`Installed 1667 ${INSTALL_VERSION} \\(beta\\)`));
  const ownershipPath = path.join(okPrefix, ".1667-install.json");
  const ownershipText = await readFile(ownershipPath, "utf8");
  const ownership = parseInstallOwnershipRecordText(ownershipText);
  assert.equal(ownership.method, "shell");
  assert.equal(ownership.channel, "beta");
  assert.equal(ownership.installRoot, await realpath(okPrefix));
  assert.equal(ownership.executable, path.join(await realpath(okPrefix), "1667"));
  assert.equal(ownership.artifactTarget, hostTarget);
  // Record path must remain a regular non-symlink file after atomic replacement.
  const ownStat = await lstat(ownershipPath);
  assert.equal(ownStat.isFile(), true);
  assert.equal(ownStat.isSymbolicLink(), false);
});

test("Shell Installer installs, probes identity, refuses existing binaries, recovers", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-script-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

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

  const scripts = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  });
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scripts["install-beta.sh"]!, { mode: 0o755 });
  await chmod(root, 0o755);

  // Existing executable refusal (fresh-install only), even without ownership.
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  await writeFile(path.join(prefix, "1667"), "#!/bin/sh\necho stolen\n", { mode: 0o755 });
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
    /existing 1667|upgrade/i
  );
  await rm(path.join(prefix, "1667"));

  // Unsafe group-writable ancestor refusal.
  const unsafe = path.join(root, "unsafe");
  await mkdir(unsafe, { mode: 0o755 });
  await chmod(unsafe, 0o775);
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", path.join(unsafe, "bin")], { cwd: root }),
    /group-writable|world-writable/i
  );

  const safePrefix = path.join(root, "safe-prefix");
  await mkdir(safePrefix, { mode: 0o755 });
  await chmod(safePrefix, 0o755);
  const { stdout, stderr } = await execFileAsync("sh", [scriptPath, "--prefix", safePrefix], {
    cwd: root
  });
  assert.match(stdout, new RegExp(`Installed 1667 ${INSTALL_VERSION} \\(beta\\)`));

  // The installer reports each slow stage. Without this the command is silent
  // for the whole transfer, and a slow network looks the same as a stall.
  const stages = [
    `info: Downloading 1667 ${INSTALL_VERSION} for ${hostTarget}`,
    "info: Checking the download",
    "info: Unpacking",
    "info: Starting 1667 once to confirm it runs"
  ];
  let searchedTo = -1;
  for (const stage of stages) {
    const at = stderr.indexOf(stage);
    assert.ok(at !== -1, `progress is missing ${JSON.stringify(stage)}:\n${stderr}`);
    assert.ok(at > searchedTo, `progress reports ${JSON.stringify(stage)} out of order:\n${stderr}`);
    searchedTo = at;
    assert.ok(!stdout.includes(stage), "progress must not reach stdout");
  }
  // 'die()' owns the '1667 install:' prefix. A successful run must not print it,
  // because anything wrapping this script can use it as a failure signal.
  assert.ok(
    !stderr.includes("1667 install:"),
    `a successful install printed the refusal prefix:\n${stderr}`
  );
  // stderr is a pipe here, so this run took the --silent branch and carries no
  // transfer bar. The terminal branch is covered separately below.
  assert.doesNotMatch(stderr, /\r/u);
  assert.ok(!stderr.includes("#"), `pipe run drew a transfer bar:\n${stderr}`);
  const ownership = parseInstallOwnershipRecordText(
    await readFile(path.join(safePrefix, ".1667-install.json"), "utf8")
  );
  assert.equal(ownership.channel, "beta");
  assert.equal(ownership.method, "shell");
  assert.equal(ownership.artifactTarget, hostTarget);

  // A terminal takes the --progress-bar branch, and every person who runs the
  // published one-line command has stderr on a terminal. A pipe-only test would
  // leave the branch that all of them use unexercised.
  const ttyPrefix = path.join(root, "tty-prefix");
  await mkdir(ttyPrefix, { mode: 0o755 });
  await chmod(ttyPrefix, 0o755);
  const pty = ptyCommand(["sh", scriptPath, "--prefix", ttyPrefix]);
  if (pty === null) {
    t.diagnostic("no pty runner on this platform; terminal progress branch not exercised");
  } else {
    const ttyRun = await execFileAsync(pty.file, pty.args, { cwd: root });
    const ttyOutput = `${ttyRun.stdout}${ttyRun.stderr}`;
    assert.match(ttyOutput, new RegExp(`Installed 1667 ${INSTALL_VERSION} \\(beta\\)`));
    // curl redraws the bar in place, so the transfer reaches the terminal.
    assert.match(ttyOutput, /\r/u);
    assert.match(ttyOutput, /100\.0%/u);
    const ttyOwnership = parseInstallOwnershipRecordText(
      await readFile(path.join(ttyPrefix, ".1667-install.json"), "utf8")
    );
    assert.equal(ttyOwnership.artifactTarget, hostTarget);
  }

  // Progress is cosmetic, and it is written between the Transaction Record and
  // the activation. A reader that closes or stops early must not end an
  // otherwise valid installation and leave recovery state behind.
  for (const [label, command] of [
    ["closed stderr", (script: string, prefix: string, status: string) =>
      `sh ${script} --prefix ${prefix} 2>&-; printf %s $? > ${status}`],
    // A pipeline reports the reader's status, so the installer's own status is
    // captured before head can mask it. head closes the pipe after two lines,
    // which is what makes the remaining writes hit a closed reader.
    ["reader stops early", (script: string, prefix: string, status: string) =>
      `{ sh ${script} --prefix ${prefix}; printf %s $? > ${status}; } 2>&1 | head -n 2`]
  ] as const) {
    const quietPrefix = path.join(root, `quiet-${label.replace(/\W+/gu, "-")}`);
    await mkdir(quietPrefix, { mode: 0o755 });
    await chmod(quietPrefix, 0o755);
    const statusPath = path.join(root, `status-${label.replace(/\W+/gu, "-")}`);
    await execFileAsync("sh", ["-c", command(scriptPath, quietPrefix, statusPath)], { cwd: root });
    // 141 is 128 + SIGPIPE. Progress is cosmetic, so it must never end the
    // installer, and the pipeline's own status cannot show that.
    assert.equal(
      await readFile(statusPath, "utf8"),
      "0",
      `${label} did not leave the installer with a zero status`
    );
    const installed = path.join(quietPrefix, "1667");
    assert.ok(existsSync(installed), `${label} did not install the executable`);
    assert.ok(
      !existsSync(path.join(quietPrefix, ".1667-install-txn.json")),
      `${label} left a Transaction Record behind`
    );
    const quietOwnership = parseInstallOwnershipRecordText(
      await readFile(path.join(quietPrefix, ".1667-install.json"), "utf8")
    );
    assert.equal(quietOwnership.artifactTarget, hostTarget);
  }

  // Candidate identity mismatch refuses activation.
  const badArchiveName = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  await writeFakeArchive(
    path.join(archivesDir, badArchiveName),
    INSTALL_VERSION,
    hostTarget,
    "9.9.9"
  );
  digests[badArchiveName] = sha256File(await readFile(path.join(archivesDir, badArchiveName)));
  const mismatchScript = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const mismatchPath = path.join(root, "install-mismatch.sh");
  await writeFile(mismatchPath, mismatchScript, { mode: 0o755 });
  const mismatchPrefix = path.join(root, "mismatch-prefix");
  await mkdir(mismatchPrefix, { mode: 0o755 });
  await chmod(mismatchPrefix, 0o755);
  await assert.rejects(
    execFileAsync("sh", [mismatchPath, "--prefix", mismatchPrefix], { cwd: root }),
    /version did not match|Candidate/i
  );

  // Checksum mismatch fails closed.
  await writeFakeArchive(path.join(archivesDir, badArchiveName), INSTALL_VERSION, hostTarget);
  digests[badArchiveName] = "0".repeat(64);
  const bad = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const badPath = path.join(root, "install-bad.sh");
  await writeFile(badPath, bad, { mode: 0o755 });
  const badPrefix = path.join(root, "bad-prefix");
  await mkdir(badPrefix, { mode: 0o755 });
  await chmod(badPrefix, 0o755);
  await assert.rejects(
    execFileAsync("sh", [badPath, "--prefix", badPrefix], { cwd: root }),
    /SHA-256|digest/i
  );

  // Interrupted after activation: rerun completes Ownership Record.
  const liveDigests: Record<string, string> = {};
  for (const target of PUBLISHED_ARTIFACT_TARGETS) {
    const name = releaseArchiveFileName(INSTALL_VERSION, target);
    await writeFakeArchive(path.join(archivesDir, name), INSTALL_VERSION, target);
    liveDigests[name] = sha256File(await readFile(path.join(archivesDir, name)));
  }
  const recoverBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests: liveDigests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  const recoverScriptPath = path.join(root, "install-recover.sh");
  await writeFile(recoverScriptPath, recoverBody, { mode: 0o755 });

  const recoverPrefix = path.join(root, "recover-prefix");
  await mkdir(recoverPrefix, { mode: 0o755 });
  await chmod(recoverPrefix, 0o755);
  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  const hostDigest = liveDigests[hostArchive]!;
  await writeFile(
    path.join(recoverPrefix, "1667"),
    releaseStub(INSTALL_VERSION, hostTarget),
    { mode: 0o755 }
  );
  const recoverRoot = await realpath(recoverPrefix);
  await writeFile(
    path.join(recoverPrefix, ".1667-install-txn.json"),
    canonicalTxnBytes({
      phase: "activated",
      version: INSTALL_VERSION,
      channel: "beta",
      target: hostTarget,
      digest: hostDigest,
      root: recoverRoot
    })
  );
  await execFileAsync("sh", [recoverScriptPath, "--prefix", recoverPrefix], { cwd: root });
  const recovered = parseInstallOwnershipRecordText(
    await readFile(path.join(recoverPrefix, ".1667-install.json"), "utf8")
  );
  assert.equal(recovered.channel, "beta");
  assert.equal(recovered.artifactTarget, hostTarget);

  // candidate-ready with active already installed completes ownership.
  const readyPrefix = path.join(root, "ready-prefix");
  await mkdir(readyPrefix, { mode: 0o755 });
  await chmod(readyPrefix, 0o755);
  const readyRoot = await realpath(readyPrefix);
  await writeFile(
    path.join(readyPrefix, "1667"),
    releaseStub(INSTALL_VERSION, hostTarget),
    { mode: 0o755 }
  );
  await writeFile(
    path.join(readyPrefix, ".1667-install-txn.json"),
    canonicalTxnBytes({
      phase: "candidate-ready",
      version: INSTALL_VERSION,
      channel: "beta",
      target: hostTarget,
      digest: hostDigest,
      root: readyRoot
    })
  );
  await execFileAsync("sh", [recoverScriptPath, "--prefix", readyPrefix], { cwd: root });
  parseInstallOwnershipRecordText(
    await readFile(path.join(readyPrefix, ".1667-install.json"), "utf8")
  );

  // Non-canonical transaction records are refused (wrong version bytes).
  const badTxnPrefix = path.join(root, "bad-txn-prefix");
  await mkdir(badTxnPrefix, { mode: 0o755 });
  await chmod(badTxnPrefix, 0o755);
  const badTxnRoot = await realpath(badTxnPrefix);
  await writeFile(
    path.join(badTxnPrefix, ".1667-install-txn.json"),
    canonicalTxnBytes({
      phase: "activated",
      version: "9.9.9",
      channel: "beta",
      target: hostTarget,
      digest: hostDigest,
      root: badTxnRoot
    })
  );
  await assert.rejects(
    execFileAsync("sh", [recoverScriptPath, "--prefix", badTxnPrefix], { cwd: root }),
    /canonical phase record/i
  );
});
