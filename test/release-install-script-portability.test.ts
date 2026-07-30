import assert from "node:assert/strict";
import {
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
import {
  renderInstallScript,
  renderInstallScriptsForVersion
} from "../scripts/release-install-script.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  digestsFor,
  execFileAsync,
  hostPublishedTarget,
  writePublishedArchives
} from "./release-install-script-fixture.js";

test("generated installer accepts SemVer build metadata with literal version probe", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-buildmeta-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  // Dots and plus must compare as literals, not ERE metacharacters.
  const version = "1.2.3+build.1";
  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, version);

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
    version,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  assert.match(scriptBody, /json_string_field/);
  // Probe uses string equality against PRODUCT_VERSION, not ERE interpolation of version.
  assert.match(scriptBody, /\[ "\$version" = "\$PRODUCT_VERSION" \]/);
  assert.match(scriptBody, /\[ "\$art" = "\$target" \]/);
  assert.doesNotMatch(scriptBody, /grep -Eq.*\$PRODUCT_VERSION/);

  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const { stdout } = await execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root });
  assert.match(stdout, new RegExp(`Installed 1667 ${version.replace(/\+/g, "\\+")} \\(beta\\)`));
  const ownership = await readFile(path.join(prefix, ".1667-install.json"), "utf8");
  assert.match(ownership, /"method": "shell"/);
});

test("Shell Installer extraction passes --no-same-owner through the external tar boundary", async (t) => {
  const body = renderInstallScript({
    version: INSTALL_VERSION,
    channel: "beta",
    repository: INSTALL_REPO,
    archives: digestsFor(INSTALL_VERSION)
  });
  assert.match(
    body,
    /tar --no-same-owner -xf "\$tar_path" -C "\$stage" "\$member"/
  );

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-no-same-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

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

  // PATH shim records every external tar argv; real /usr/bin/tar still extracts.
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o755 });
  const tarLog = path.join(root, "tar-argv.log");
  await writeFile(
    path.join(bin, "tar"),
    [
      "#!/bin/sh",
      `log=${JSON.stringify(tarLog)}`,
      'printf "%s\\n" "$*" >> "$log"',
      'exec /usr/bin/tar "$@"'
    ].join("\n") + "\n",
    { mode: 0o755 }
  );

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  await chmod(root, 0o755);
  const { stdout } = await execFileAsync("sh", [scriptPath, "--prefix", prefix], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  assert.match(stdout, new RegExp(`Installed 1667 ${INSTALL_VERSION} \\(beta\\)`));

  const tarInvocations = (await readFile(tarLog, "utf8")).trimEnd().split("\n");
  assert.ok(tarInvocations.length > 0, "installer must invoke external tar");
  const extractCalls = tarInvocations.filter((line) => {
    return /(?:^|\s)-x(?:\s|$)/.test(line) || /(?:^|\s)-xf(?:\s|$)/.test(line);
  });
  assert.ok(extractCalls.length >= 1, "installer must extract with external tar");
  for (const call of extractCalls) {
    assert.match(call, /(?:^|\s)--no-same-owner(?:\s|$)/);
    // Extract uses the private validated tar, not the gzip download path.
    assert.match(call, /(?:^|\s)-xf(?:\s|$)/);
    assert.doesNotMatch(call, /(?:^|\s)-xzf(?:\s|$)/);
  }
});
