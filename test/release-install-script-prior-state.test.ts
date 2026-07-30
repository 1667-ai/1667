/**
 * Fresh install must refuse prior managed state before download.
 * Ownership Record, previous, previous.next, and reserved staging fail closed;
 * lock may remain. No Transaction Record must not delete unowned staging.
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  INSTALL_CANDIDATE_FILE,
  INSTALL_PACKAGE_STAGING_FILE,
  INSTALL_PREVIOUS_FILE,
  INSTALL_PREVIOUS_NEXT_FILE
} from "../shared/install-layout.js";
import { INSTALL_OWNERSHIP_FILE } from "../shared/install-ownership-record.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  execFileAsync,
  hostPublishedTarget,
  writePublishedArchives
} from "./release-install-script-fixture.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";

test("fresh install refuses stale previous before download and preserves bytes", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-prior-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  let downloadHits = 0;
  const server = createServer((_request, response) => {
    downloadHits += 1;
    response.writeHead(500);
    response.end("should-not-download");
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
  assert.match(scriptBody, /PREVIOUS_FILE='\.1667-previous'/);
  assert.match(scriptBody, /PREVIOUS_NEXT_FILE='\.1667-previous\.next'/);
  assert.match(scriptBody, /refuse_prior_managed_path/);
  const scriptPath = path.join(root, "install-prior.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  // Active missing; stale previous present (unrelated prior install residue).
  const previousPath = path.join(prefix, INSTALL_PREVIOUS_FILE);
  const previousBytes = Buffer.from("stale-previous-unrelated-install\n");
  await writeFile(previousPath, previousBytes, { mode: 0o755 });

  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const extra = error as Error & { stderr?: string | Buffer };
      const stderr = typeof extra.stderr === "string"
        ? extra.stderr
        : Buffer.isBuffer(extra.stderr)
          ? extra.stderr.toString("utf8")
          : "";
      const text = `${error.message}\n${stderr}`;
      return /prior managed state|previous executable/i.test(text)
        && !/Download failed/i.test(text);
    }
  );

  assert.equal(downloadHits, 0, "must refuse before download");
  assert.equal(await readFile(previousPath).then((b) => b.equals(previousBytes)), true);
  await assert.rejects(access(path.join(prefix, "1667")));
  await assert.rejects(access(path.join(prefix, INSTALL_OWNERSHIP_FILE)));
  await assert.rejects(access(path.join(prefix, INSTALL_PREVIOUS_NEXT_FILE)));
});

test("fresh install refuses Ownership Record and previous.next residue", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-prior-own-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  let downloadHits = 0;
  const server = createServer((_request, response) => {
    downloadHits += 1;
    response.writeHead(500);
    response.end("should-not-download");
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
  const scriptPath = path.join(root, "install-prior-own.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  for (const { name, label } of [
    { name: INSTALL_OWNERSHIP_FILE, label: /Ownership Record/i },
    { name: INSTALL_PREVIOUS_NEXT_FILE, label: /staged previous/i }
  ] as const) {
    const prefix = path.join(root, `prefix-${name.replace(/^\./u, "")}`);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const residuePath = path.join(prefix, name);
    const residueBytes = Buffer.from(`stale-${name}\n`);
    await writeFile(residuePath, residueBytes);

    await assert.rejects(
      execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const extra = error as Error & { stderr?: string | Buffer };
        const stderr = typeof extra.stderr === "string"
          ? extra.stderr
          : Buffer.isBuffer(extra.stderr)
            ? extra.stderr.toString("utf8")
            : "";
        return /prior managed state/i.test(`${error.message}\n${stderr}`)
          && label.test(`${error.message}\n${stderr}`);
      }
    );
    assert.equal(await readFile(residuePath).then((b) => b.equals(residueBytes)), true);
    await assert.rejects(access(path.join(prefix, "1667")));
  }
  assert.equal(downloadHits, 0, "must refuse before download");
});

test("no-txn preserves reserved staging and refuses before download", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-no-txn-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  let downloadHits = 0;
  const server = createServer((_request, response) => {
    downloadHits += 1;
    response.writeHead(500);
    response.end("should-not-download");
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
  assert.match(scriptBody, /CLEANUP_OWNS_STAGING=0/);
  assert.match(scriptBody, /PACKAGE_STAGING_FILE='\.1667-package\.tgz'/);
  assert.match(scriptBody, /refuse_prior_managed_path "\$prefix\/\$EXTRACT_STAGE"/);
  assert.doesNotMatch(
    scriptBody,
    /if \[ ! -e "\$txn" \]; then\s*# Still clear[\s\S]*?remove_extract_stage/
  );
  const scriptPath = path.join(root, "install-no-txn.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  // Parameterized reserved paths: each must survive refusal with exact bytes.
  const reserved = [
    {
      name: ".1667-extract",
      kind: "dir" as const,
      label: /extract staging/i,
      sentinel: "unowned-extract-sentinel\n"
    },
    {
      name: INSTALL_CANDIDATE_FILE,
      kind: "file" as const,
      label: /candidate executable/i,
      sentinel: "unowned-candidate-sentinel\n"
    },
    {
      name: ".1667-probe-output",
      kind: "file" as const,
      label: /probe output/i,
      sentinel: "unowned-probe-sentinel\n"
    },
    {
      name: INSTALL_PACKAGE_STAGING_FILE,
      kind: "file" as const,
      label: /package staging/i,
      sentinel: "unowned-package-sentinel\n"
    },
    {
      name: hostArchive,
      kind: "file" as const,
      label: /Release Archive staging/i,
      sentinel: "unowned-archive-sentinel\n"
    }
  ];

  for (const entry of reserved) {
    const prefix = path.join(root, `prefix-${entry.name.replace(/^\./u, "").replace(/[^A-Za-z0-9_-]/gu, "_")}`);
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const residuePath = path.join(prefix, entry.name);
    const sentinelBytes = Buffer.from(entry.sentinel);
    if (entry.kind === "dir") {
      await mkdir(residuePath, { mode: 0o700 });
      await writeFile(path.join(residuePath, "sentinel"), sentinelBytes);
    } else {
      await writeFile(residuePath, sentinelBytes);
    }

    await assert.rejects(
      execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const extra = error as Error & { stderr?: string | Buffer };
        const stderr = typeof extra.stderr === "string"
          ? extra.stderr
          : Buffer.isBuffer(extra.stderr)
            ? extra.stderr.toString("utf8")
            : "";
        const text = `${error.message}\n${stderr}`;
        return /prior managed state/i.test(text)
          && entry.label.test(text)
          && !/Download failed/i.test(text);
      }
    );

    if (entry.kind === "dir") {
      assert.equal(
        await readFile(path.join(residuePath, "sentinel")).then((b) => b.equals(sentinelBytes)),
        true,
        `${entry.name} sentinel must survive`
      );
    } else {
      assert.equal(
        await readFile(residuePath).then((b) => b.equals(sentinelBytes)),
        true,
        `${entry.name} bytes must survive`
      );
    }
    await assert.rejects(access(path.join(prefix, "1667")));
    await assert.rejects(access(path.join(prefix, INSTALL_OWNERSHIP_FILE)));
    // Lock file may remain; it must not still be held after refusal.
    const lock = await acquireInstallationLock(prefix);
    await lock.release();
  }
  assert.equal(downloadHits, 0, "must refuse before download");
});
