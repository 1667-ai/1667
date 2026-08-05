import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RELEASE_LAUNCHER_PACKAGE } from "../shared/release-targets.js";
import {
  prepareOrVerifyGitHubRelease,
  publishOrVerifyGitHubRelease,
  verifyNpmReleaseAssetDirectory
} from "../scripts/release-npm-github.js";
import {
  NpmReleaseRegistry,
  npmDistTagForVersion
} from "../scripts/release-npm-registry.js";
import type { NpmPublicationPackage } from "../scripts/release-npm-publisher.js";
import {
  fakeReleaseGh,
  writeReleaseAssetFixture
} from "./release-npm-github-fixture.js";

const GITHUB_REPOSITORY = "1667-ai/1667";
const REPOSITORY_URL = "https://github.com/1667-ai/1667";
const WORKFLOW_PATH = ".github/workflows/release-npm.yml";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
// The npm provenance certificate fixture is signed for this exact ref. It
// binds only the *build* identity (repository, workflow, ref) — the package
// name, version, and digest it attests to live in the DSSE payload this file
// builds itself (see provenanceAudit below), so one fixture certificate
// covers every package version this file exercises.
const SOURCE_REF = "refs/tags/v1.2.3";
const PROVENANCE_CERTIFICATE = readFileSync(
  new URL("fixtures/npm-provenance-certificate.base64", import.meta.url),
  "utf8"
).trim();
const STABLE_ONLY_INSTALLERS = ["install-stable.sh", "install-stable.ps1"] as const;

/**
 * Applies the release channel policy at the GitHub asset, GitHub release, and
 * npm publication boundaries. A stable version must use the npm `latest` tag.
 * It must include the stable Installers. A prerelease version must use the npm
 * `beta` tag. It must include only the beta Installers.
 *
 * These components do not pass one artifact between them. Thus, this test does
 * not claim to test that handoff. The unsigned-tag integration in
 * test/release-producer.test.ts passes real output through staging, packing,
 * preflight, installation, and launch.
 */
for (const scenario of [
  {
    label: "a stable version",
    version: "4.5.0",
    tag: "latest" as const,
    installers: [
      "install-beta.sh",
      "install-beta.ps1",
      "install-stable.sh",
      "install-stable.ps1"
    ]
  },
  {
    label: "a prerelease version",
    version: "4.5.0-rc.1",
    tag: "beta" as const,
    installers: ["install-beta.sh", "install-beta.ps1"]
  }
] as const) {
  test(`${scenario.label} applies channel policy to GitHub and npm`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "1667-channel-policy-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    // Build the complete asset directory with the production name and
    // Installer renderers. Use fixture bytes for the native archives.
    const assets = path.join(root, "assets");
    await mkdir(assets);
    await writeReleaseAssetFixture(assets, scenario.version, GITHUB_REPOSITORY);
    const staged = verifyNpmReleaseAssetDirectory(assets, scenario.version, GITHUB_REPOSITORY)
      .map((file) => path.basename(file));
    assertInstallerSet(staged, scenario, `${scenario.label}: staged assets`);

    // Create and verify the GitHub release through the production functions.
    const remote = path.join(root, "remote");
    const state = path.join(root, "state.json");
    const ghLog = path.join(root, "gh.log");
    const notes = path.join(root, "notes.md");
    const gh = path.join(root, "gh");
    await writeFile(notes, `# 1667 v${scenario.version}\n`);
    await writeFile(gh, fakeReleaseGh({ remote, state, log: ghLog }));
    await chmod(gh, 0o755);
    const releaseOptions = {
      version: scenario.version,
      sourceCommit: COMMIT,
      assetsDirectory: assets,
      notesFile: notes,
      environment: { GITHUB_REPOSITORY, GH_TOKEN: "test-token", HOME: root },
      ghExecutable: gh
    };
    await prepareOrVerifyGitHubRelease(releaseOptions);
    await publishOrVerifyGitHubRelease(releaseOptions);
    const published = JSON.parse(await readFile(state, "utf8")) as { isPrerelease: boolean };
    assert.equal(
      published.isPrerelease,
      scenario.tag === "beta",
      `${scenario.label}: published GitHub release has the wrong channel`
    );
    assertInstallerSet(await readdir(remote), scenario, `${scenario.label}: published release`);

    // -- npm publication: publish through a fake npm CLI, asserting the
    // recorded invocation carries the expected --tag, then complete registry
    // verification against a dist-tag set where only that tag names the
    // version — a check reading the other channel would never settle here.
    const previousTokens = ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_AUTH_TOKEN"].map((name) => {
      return [name, process.env[name]] as const;
    });
    for (const [name] of previousTokens) delete process.env[name];
    t.after(() => {
      for (const [name, value] of previousTokens) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const packageToPublish: NpmPublicationPackage = {
      artifactTarget: "launcher",
      name: RELEASE_LAUNCHER_PACKAGE,
      version: scenario.version,
      tarballPath: path.join(root, "launcher.tgz"),
      sha256: "a".repeat(64),
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`
    };
    const npmCli = path.join(root, "npm.cjs");
    const npmLog = path.join(root, "npm.log");
    const audit = provenanceAudit(packageToPublish);
    await writeFile(npmCli, [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify({`,
      "  args: process.argv.slice(2)",
      "}) + \"\\n\");",
      `if (process.argv[2] === "audit") process.stdout.write(${
        JSON.stringify(JSON.stringify(audit))
      });`,
      ""
    ].join("\n"));
    await chmod(npmCli, 0o755);

    const otherTag = scenario.tag === "beta" ? "latest" : "beta";
    const registry = new NpmReleaseRegistry({
      npm: { nodeExecutable: process.execPath, npmCli },
      sourceCommit: COMMIT,
      sourceRef: SOURCE_REF,
      visibilityTimeoutMs: 1_000,
      pollIntervalMs: 1,
      fetch: async (input) => {
        if (new URL(String(input)).pathname.endsWith(`/${packageToPublish.version}`)) {
          return jsonResponse({
            name: packageToPublish.name,
            version: packageToPublish.version,
            dist: {
              integrity: packageToPublish.integrity,
              attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" }
            }
          });
        }
        return jsonResponse({
          name: packageToPublish.name,
          "dist-tags": { [scenario.tag]: packageToPublish.version, [otherTag]: "0.0.1" }
        });
      },
      sleep: async () => {}
    });

    assert.equal(npmDistTagForVersion(scenario.version), scenario.tag);
    await registry.publish(packageToPublish);
    const publishCalls = (await readFile(npmLog, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    assert.equal(publishCalls[0]?.args[0], "publish");
    assert.ok(
      publishCalls[0]?.args.includes(`--tag=${scenario.tag}`),
      `${scenario.label} published with ${JSON.stringify(publishCalls[0]?.args)}`
    );
    assert.ok(!publishCalls[0]?.args.includes(`--tag=${otherTag}`));

    // Settles only because the fake registry above names the version under
    // scenario.tag: the packages land on that dist-tag.
    await registry.waitUntilVerified([packageToPublish]);
  });
}

function assertInstallerSet(
  names: readonly string[],
  scenario: { readonly installers: readonly string[] },
  label: string
): void {
  for (const installer of scenario.installers) {
    assert.ok(names.includes(installer), `${label} omit ${installer}`);
  }
  for (const installer of STABLE_ONLY_INSTALLERS) {
    if (!(scenario.installers as readonly string[]).includes(installer)) {
      assert.ok(!names.includes(installer), `${label} carry ${installer}`);
    }
  }
}

function provenanceAudit(expected: NpmPublicationPackage): unknown {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      name: `pkg:npm/%401667-ai/cli@${expected.version}`,
      digest: { sha512: "01".repeat(64) }
    }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: WORKFLOW_PATH,
            repository: REPOSITORY_URL,
            ref: SOURCE_REF
          }
        },
        resolvedDependencies: [{
          uri: `git+${REPOSITORY_URL}@${SOURCE_REF}`,
          digest: { gitCommit: COMMIT }
        }]
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" }
      }
    }
  };
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: expected.name,
      version: expected.version,
      attestationBundles: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          verificationMaterial: {
            certificate: { rawBytes: PROVENANCE_CERTIFICATE }
          },
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64")
          }
        }
      }]
    }]
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}
