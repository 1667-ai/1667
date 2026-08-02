import assert from "node:assert/strict";
import test from "node:test";
import {
  installScriptChannelsForVersion,
  renderInstallScript,
  renderInstallScriptsForVersion
} from "../scripts/release-install-script.js";
import {
  INSTALL_NIGHTLY_VERSION,
  INSTALL_REPO,
  INSTALL_VERSION,
  digestsFor
} from "./release-install-script-fixture.js";

test("a nightly version produces the nightly channel alone", () => {
  assert.deepEqual(installScriptChannelsForVersion(INSTALL_NIGHTLY_VERSION), ["nightly"]);
});

test("a nightly version renders install-nightly.sh and install-nightly.ps1 and nothing else", () => {
  const archives = digestsFor(INSTALL_NIGHTLY_VERSION);
  const digests = Object.fromEntries(archives.map((a) => [a.fileName, a.sha256]));
  const scripts = renderInstallScriptsForVersion({
    version: INSTALL_NIGHTLY_VERSION,
    repository: INSTALL_REPO,
    digests
  });
  assert.deepEqual(Object.keys(scripts).sort(), ["install-nightly.ps1", "install-nightly.sh"]);
});

test("the nightly Installers embed exact digests and download from the fixed nightly tag", () => {
  const archives = digestsFor(INSTALL_NIGHTLY_VERSION);
  const digests = Object.fromEntries(archives.map((a) => [a.fileName, a.sha256]));
  const scripts = renderInstallScriptsForVersion({
    version: INSTALL_NIGHTLY_VERSION,
    repository: INSTALL_REPO,
    digests
  });
  const shBody = scripts["install-nightly.sh"]!;
  const psBody = scripts["install-nightly.ps1"]!;

  for (const archive of archives) {
    const targetBody = archive.target === "windows-x64" ? psBody : shBody;
    assert.match(targetBody, new RegExp(archive.fileName.replace(/\./g, "\\.")));
    assert.match(targetBody, new RegExp(archive.sha256));
  }

  assert.match(shBody, new RegExp(`https://github\\.com/${INSTALL_REPO}/releases/download/nightly`));
  assert.match(psBody, new RegExp(`https://github\\.com/${INSTALL_REPO}/releases/download/nightly`));
  assert.doesNotMatch(shBody, new RegExp(`releases/download/v${INSTALL_NIGHTLY_VERSION}`));
  assert.doesNotMatch(psBody, new RegExp(`releases/download/v${INSTALL_NIGHTLY_VERSION}`));
});

test("an Installer refuses a channel its version does not produce", () => {
  const nightlyArchives = digestsFor(INSTALL_NIGHTLY_VERSION);
  assert.throws(
    () => renderInstallScript({
      version: INSTALL_NIGHTLY_VERSION,
      channel: "beta",
      repository: INSTALL_REPO,
      archives: nightlyArchives
    }),
    /is not valid for a nightly version/u
  );

  const stableArchives = digestsFor(INSTALL_VERSION);
  assert.throws(
    () => renderInstallScript({
      version: INSTALL_VERSION,
      channel: "nightly",
      repository: INSTALL_REPO,
      archives: stableArchives
    }),
    /is only valid for a nightly version/u
  );
});
