import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  releasePackageContentFileSet,
  stageReleaseContent
} from "../scripts/release-content.js";
import {
  createReleaseLauncherPackageTemplate
} from "../scripts/release-package-templates.js";
import {
  createReleaseSboms,
  releaseSbomForPackage,
  repositoryReleaseComponentSources
} from "../scripts/release-sbom.js";
import {
  releaseIdentitiesForSource,
  releaseSbomSourceForFacts
} from "../scripts/release-source-facts.js";

const FACTS = Object.freeze({
  version: "0.1.2-beta.2",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  buildTimestamp: "2026-07-28T10:20:30.000Z"
});

test("the content assembler refuses entries that differ from the template", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "1667-release-content-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identities = releaseIdentitiesForSource(FACTS);
  const template = createReleaseLauncherPackageTemplate(identities);
  const entries = releasePackageContentFileSet(
    template,
    { executablePath: "bin/1667.js" }
  ).filter((entry) => entry.path !== "LICENSE");
  const output = path.join(root, "package");
  assert.throws(() => stageReleaseContent({
    template,
    sbom: releaseSbomForPackage(
      createReleaseSboms(releaseSbomSourceForFacts(FACTS), repositoryReleaseComponentSources()),
      template.packageManifest.name
    ),
    entries,
    executable: path.join(process.cwd(), "release", "npm", "launcher.mjs"),
    directory: output,
    layout: { executablePath: "bin/1667.js" }
  }), /do not match/);
  assert.equal(existsSync(output), false);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".package-")),
    false
  );
});
