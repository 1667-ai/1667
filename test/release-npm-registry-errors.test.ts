import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NpmReleaseRegistry
} from "../scripts/release-npm-registry.js";
import {
  NpmPublicationAlreadyExistsError,
  type NpmPublicationPackage
} from "../scripts/release-npm-publisher.js";
import { RELEASE_LAUNCHER_PACKAGE } from "../shared/release-targets.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_REF = "refs/heads/main";
const PROVENANCE_CERTIFICATE = readFileSync(
  new URL("fixtures/npm-provenance-certificate.base64", import.meta.url),
  "utf8"
).trim();

test("a non-zero audit with invalid evidence fails without polling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-audit-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFakeNpm(npmCli, {
    invalid: [{ name: RELEASE_LAUNCHER_PACKAGE, version: VERSION }],
    missing: [],
    verified: []
  });
  let sleeps = 0;
  const registry = registryFor(npmCli, async () => {
    sleeps += 1;
  });
  await assert.rejects(
    registry.waitUntilVerified([publicationPackage()]),
    /invalid evidence/u
  );
  assert.equal(sleeps, 0);
});

test("a non-zero audit with missing evidence retries its structured result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-audit-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  const count = path.join(root, "audit-count");
  const expected = publicationPackage();
  const verified = provenanceAudit(expected);
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `const count = ${JSON.stringify(count)};`,
    'if (process.argv[2] === "audit") {',
    "  const attempt = fs.existsSync(count) ? Number(fs.readFileSync(count)) + 1 : 1;",
    "  fs.writeFileSync(count, String(attempt));",
    "  if (attempt === 1) {",
    `    process.stdout.write(${JSON.stringify(JSON.stringify({
      invalid: [],
      missing: [{ name: expected.name, version: expected.version }],
      verified: []
    }))});`,
    "    process.exitCode = 1;",
    "  } else {",
    `    process.stdout.write(${JSON.stringify(JSON.stringify(verified))});`,
    "  }",
    "}",
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);
  let sleeps = 0;
  const registry = registryFor(npmCli, async () => {
    sleeps += 1;
  });
  await registry.waitUntilVerified([expected]);
  assert.equal(sleeps, 1);
});

test("npm's immutable-version refusal becomes a recoverable publication result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-publish-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, [
    'if (process.argv[2] === "publish") {',
    '  process.stderr.write("npm error code E403\\n");',
    '  process.stderr.write("npm error You cannot publish over the previously published versions\\n");',
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);
  const registry = registryFor(npmCli, async () => undefined);
  await assert.rejects(
    registry.publish(publicationPackage()),
    NpmPublicationAlreadyExistsError
  );
});

function registryFor(
  npmCli: string,
  sleep: (milliseconds: number) => Promise<void>
): NpmReleaseRegistry {
  const expected = publicationPackage();
  return new NpmReleaseRegistry({
    npm: { nodeExecutable: process.execPath, npmCli },
    sourceCommit: COMMIT,
    sourceRef: SOURCE_REF,
    visibilityTimeoutMs: 1_000,
    pollIntervalMs: 1,
    fetch: async (input) => {
      const exactVersion = new URL(String(input)).pathname.endsWith(`/${VERSION}`);
      return new Response(JSON.stringify(exactVersion ? {
        name: expected.name,
        version: expected.version,
        dist: {
          integrity: expected.integrity,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/test"
          }
        }
      } : {
        name: expected.name,
        "dist-tags": { next: expected.version }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    },
    sleep
  });
}

async function writeFakeNpm(file: string, audit: unknown): Promise<void> {
  await writeFile(file, [
    'if (process.argv[2] === "audit") {',
    `  process.stdout.write(${JSON.stringify(JSON.stringify(audit))});`,
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n"));
  await chmod(file, 0o755);
}

function publicationPackage(): NpmPublicationPackage {
  return {
    artifactTarget: "launcher",
    name: RELEASE_LAUNCHER_PACKAGE,
    version: VERSION,
    tarballPath: "/tmp/launcher.tgz",
    sha256: "a".repeat(64),
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`
  };
}

function provenanceAudit(expected: NpmPublicationPackage): unknown {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      name: `pkg:npm/%401667-ai/cli@${VERSION}`,
      digest: { sha512: "01".repeat(64) }
    }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: ".github/workflows/release-npm.yml",
            repository: "https://github.com/1667-ai/1667",
            ref: SOURCE_REF
          }
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/1667-ai/1667@${SOURCE_REF}`,
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
