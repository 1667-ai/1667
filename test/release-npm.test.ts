import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPackagedBuildIdentity
} from "../shared/build-identity.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../shared/release-targets.js";
import {
  NPM_PUBLICATION_READY,
  requireNpmPublicationReady,
  validateReleaseCandidate,
  validateReleaseReplay,
  type ReleaseCompletionRef
} from "../scripts/release-completion.js";
import {
  observeReleaseExecutable,
  parseReleaseExecutableObservation
} from "../scripts/release-npm-observation.js";
import {
  githubPublicationAuthority
} from "../scripts/release-npm-publish.js";
import {
  NpmReleaseRegistry,
  validateNpmAuditProvenance,
  validateRegistryVersion
} from "../scripts/release-npm-registry.js";
import {
  publishNpmRelease,
  type NpmPublicationLedger,
  type NpmPublicationPackage,
  type NpmPublicationRegistry
} from "../scripts/release-npm-publisher.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TIMESTAMP = "2026-07-28T10:20:30.000Z";
const SOURCE_REF = "refs/heads/main";
const WORKFLOW = ".github/workflows/release-npm.yml";
const REPOSITORY = "https://github.com/1667-ai/1667";
const PROVENANCE_CERTIFICATE = readFileSync(
  new URL("fixtures/npm-provenance-certificate.base64", import.meta.url),
  "utf8"
).trim();

test("native observation binds the reported identity to executable bytes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = PUBLISHED_ARTIFACT_TARGETS[0]!;
  const identity = {
    ...createPackagedBuildIdentity({
      productVersion: VERSION,
      sourceCommit: COMMIT,
      sourceDirty: false,
      buildTimestamp: TIMESTAMP,
      artifactTarget: target
    }),
    buildKind: "release" as const
  };
  const executable = path.join(root, "1667");
  await writeFile(executable, [
    `#!${process.execPath}`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(identity))});`,
    ""
  ].join("\n"));
  await chmod(executable, 0o755);
  const observation = await observeReleaseExecutable(target, executable);
  assert.equal(observation.artifactTarget, target);
  assert.equal(
    observation.executable.sha256,
    createHash("sha256").update(await readFile(executable)).digest("hex")
  );
  assert.deepEqual(
    parseReleaseExecutableObservation(JSON.parse(JSON.stringify(observation)), target),
    observation
  );
  assert.throws(() => parseReleaseExecutableObservation(
    { ...observation, executable: { ...observation.executable, sha256: "not-a-digest" } },
    target
  ), /SHA-256/u);
  const other = PUBLISHED_ARTIFACT_TARGETS[1]!;
  assert.throws(
    () => parseReleaseExecutableObservation(observation, other),
    /expected/u
  );
});

test("completion tags exclude the candidate and impose strict release order", () => {
  validateReleaseCandidate(VERSION, COMMIT, []);
  const completed = completion("1.2.2");
  validateReleaseCandidate(VERSION, COMMIT, [completed]);
  assert.throws(
    () => validateReleaseCandidate("1.2.2", COMMIT, [completed]),
    /already complete/u
  );
  assert.throws(
    () => validateReleaseCandidate("1.2.1", COMMIT, [completed]),
    /does not follow/u
  );
  assert.throws(
    () => validateReleaseCandidate(VERSION, COMMIT, [
      { ...completed, ref: "refs/tags/released/not-a-version" }
    ]),
    /Unexpected/u
  );
  assert.equal(validateReleaseReplay("1.2.2", COMMIT, [completed]), "present");
  assert.equal(validateReleaseReplay(VERSION, COMMIT, [completed]), "missing");
  assert.throws(
    () => validateReleaseReplay("1.2.2", "f".repeat(40), [completed]),
    /different commit/u
  );
});

test("npm publication remains blocked after the SBOM boundary change", () => {
  assert.equal(NPM_PUBLICATION_READY, false);
  assert.throws(() => requireNpmPublicationReady(), /prepublication release controls/u);
});

test("verify mode does not require GitHub publication authority", () => {
  assert.equal(githubPublicationAuthority("verify", {}), undefined);
  assert.throws(
    () => githubPublicationAuthority("publish", {}),
    /requires GitHub publication authority/u
  );
  assert.deepEqual(
    githubPublicationAuthority("publish", {
      GITHUB_REPOSITORY: "1667-ai/1667",
      GH_TOKEN: "test-token"
    }),
    {
      repository: "1667-ai/1667",
      token: "test-token"
    }
  );
});

test("publication resumes platforms in order and publishes the launcher last", async () => {
  const packages = publicationMatrix();
  const calls: string[] = [];
  const present = new Set([packages[1]!.name]);
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      calls.push(`inspect:${entry.name}`);
      return present.has(entry.name) ? "present" : "missing";
    },
    async publish(entry) {
      calls.push(`publish:${entry.name}`);
      present.add(entry.name);
    },
    async waitUntilVerified(entries) {
      calls.push(`wait:${entries.map((entry) => entry.name).join(",")}`);
    }
  };
  await publishNpmRelease(packages, registry, publicationLedger());
  assert.deepEqual(calls, [
    `inspect:${packages[1]!.name}`,
    `wait:${packages[1]!.name}`,
    `inspect:${packages[2]!.name}`,
    `publish:${packages[2]!.name}`,
    `wait:${packages[2]!.name}`,
    `inspect:${packages[3]!.name}`,
    `publish:${packages[3]!.name}`,
    `wait:${packages[3]!.name}`,
    `inspect:${packages[4]!.name}`,
    `publish:${packages[4]!.name}`,
    `wait:${packages[4]!.name}`,
    `wait:${packages.slice(1).map((entry) => entry.name).join(",")}`,
    `inspect:${RELEASE_LAUNCHER_PACKAGE}`,
    `publish:${RELEASE_LAUNCHER_PACKAGE}`,
    `wait:${RELEASE_LAUNCHER_PACKAGE}`,
    `wait:${packages.map((entry) => entry.name).join(",")}`
  ]);
});

test("a present platform is fully verified before later npm writes", async () => {
  const packages = publicationMatrix();
  const present = packages[1]!;
  const published: string[] = [];
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return entry.name === present.name ? "present" : "missing";
    },
    async publish(entry) {
      published.push(entry.name);
    },
    async waitUntilVerified(entries) {
      if (entries.length === 1 && entries[0]?.name === present.name) {
        throw new Error("wrong provenance");
      }
    }
  };
  await assert.rejects(
    publishNpmRelease(packages, registry, publicationLedger()),
    /wrong provenance/u
  );
  assert.deepEqual(published, []);
});

test("a platform digest refusal stops before launcher publication", async () => {
  const packages = publicationMatrix();
  const published: string[] = [];
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      if (entry.artifactTarget === PUBLISHED_ARTIFACT_TARGETS[1]) {
        throw new Error("different registry digest");
      }
      return "missing";
    },
    async publish(entry) {
      published.push(entry.name);
    },
    async waitUntilVerified() {}
  };
  await assert.rejects(
    publishNpmRelease(packages, registry, publicationLedger()),
    /different registry digest/u
  );
  assert.deepEqual(published, [packages[1]!.name]);
  assert.ok(!published.includes(RELEASE_LAUNCHER_PACKAGE));
});

test("registry metadata requires exact bytes, attestations and no deprecation", () => {
  const expected = publicationMatrix()[0]!;
  const metadata = {
    name: expected.name,
    version: expected.version,
    dist: {
      integrity: expected.integrity,
      attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" }
    }
  };
  validateRegistryVersion(metadata, expected);
  assert.throws(
    () => validateRegistryVersion({
      ...metadata,
      dist: { ...metadata.dist, integrity: "sha512-wrong" }
    }, expected),
    /different registry digest/u
  );
  assert.throws(
    () => validateRegistryVersion({ ...metadata, deprecated: "withdrawn" }, expected),
    /deprecated/u
  );
  assert.throws(
    () => validateRegistryVersion({
      ...metadata,
      dist: { integrity: expected.integrity }
    }, expected),
    /attestations/u
  );
});

test("registry publication refuses an ambient npm token", () => {
  const previous = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = "forbidden";
  try {
    assert.throws(() => new NpmReleaseRegistry({
      npm: {
        nodeExecutable: process.execPath,
        npmCli: fileURLToPath(import.meta.url)
      },
      sourceCommit: COMMIT,
      sourceRef: SOURCE_REF
    }), /refuses credential variable NPM_TOKEN/u);
  } finally {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
  }
});

test("registry polling retries unsettled responses but stops on a digest refusal", async () => {
  const expected = publicationMatrix()[0]!;
  let requests = 0;
  let sleeps = 0;
  const registry = new NpmReleaseRegistry({
    npm: {
      nodeExecutable: process.execPath,
      npmCli: fileURLToPath(import.meta.url)
    },
    sourceCommit: COMMIT,
    sourceRef: SOURCE_REF,
    visibilityTimeoutMs: 1_000,
    pollIntervalMs: 1,
    fetch: async () => {
      requests += 1;
      if (requests === 1) return new Response("", { status: 503 });
      if (requests === 2) {
        return jsonResponse({
          name: expected.name,
          version: expected.version,
          dist: { integrity: expected.integrity }
        });
      }
      return jsonResponse({
        name: expected.name,
        version: expected.version,
        dist: {
          integrity: "sha512-wrong",
          attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" }
        }
      });
    },
    sleep: async () => {
      sleeps += 1;
    }
  });
  await assert.rejects(
    registry.waitUntilVerified([expected]),
    /different registry digest/u
  );
  assert.equal(requests, 3);
  assert.equal(sleeps, 2);
});

test("registry verification waits for the next tag and audits package bytes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousGhToken = process.env.GH_TOKEN;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "ledger-token";
  process.env.GITHUB_TOKEN = "workflow-token";
  t.after(() => {
    restoreEnvironment("GH_TOKEN", previousGhToken);
    restoreEnvironment("GITHUB_TOKEN", previousGitHubToken);
  });
  const expected = publicationMatrix()[0]!;
  const log = path.join(root, "npm.log");
  const npmCli = path.join(root, "npm.cjs");
  const audit = provenanceAudit(expected, provenanceStatement());
  let nextTagRequests = 0;
  let sleeps = 0;
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
    "  args: process.argv.slice(2),",
    "  ignoreScripts: process.env.npm_config_ignore_scripts,",
    "  provenance: process.env.npm_config_provenance,",
    "  token: process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN,",
    "  githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN",
    "}) + \"\\n\");",
    `if (process.argv[2] === "audit") process.stdout.write(${
      JSON.stringify(JSON.stringify(audit))
    });`,
    ""
  ].join("\n"));
  const registry = new NpmReleaseRegistry({
    npm: { nodeExecutable: process.execPath, npmCli },
    sourceCommit: COMMIT,
    sourceRef: SOURCE_REF,
    visibilityTimeoutMs: 1_000,
    pollIntervalMs: 1,
    fetch: async (input) => {
      if (new URL(String(input)).pathname.endsWith(`/${expected.version}`)) {
        return jsonResponse({
          name: expected.name,
          version: expected.version,
          dist: {
            integrity: expected.integrity,
            attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" }
          }
        });
      }
      nextTagRequests += 1;
      return jsonResponse({
        name: expected.name,
        "dist-tags": {
          next: nextTagRequests === 1 ? "1.2.2" : expected.version
        }
      });
    },
    sleep: async () => {
      sleeps += 1;
    }
  });
  await registry.waitUntilVerified([expected]);
  const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as {
      args: string[];
      ignoreScripts: string;
      provenance: string;
      token?: string;
      githubToken?: string;
    };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.args[0], "install");
  assert.ok(calls[0]?.args.includes("--force"));
  assert.ok(calls[0]?.args.includes("--ignore-scripts"));
  assert.ok(!calls[0]?.args.includes("--package-lock-only"));
  assert.equal(calls[1]?.args[0], "audit");
  assert.ok(calls[1]?.args.includes("--include-attestations"));
  assert.equal(nextTagRequests, 2);
  assert.equal(sleeps, 1);
  for (const call of calls) {
    assert.equal(call.ignoreScripts, "true");
    assert.equal(call.provenance, "true");
    assert.equal(call.token, undefined);
    assert.equal(call.githubToken, undefined);
  }
});

test("verified npm provenance must name this workflow, ref and commit", () => {
  const expected = publicationMatrix()[0]!;
  const statement = provenanceStatement();
  const audit = provenanceAudit(expected, statement);
  const source = {
    sourceCommit: COMMIT,
    sourceRef: SOURCE_REF,
    workflowPath: WORKFLOW,
    repositoryUrl: REPOSITORY
  };
  validateNpmAuditProvenance(audit, expected, source);
  const wrongWorkflow = structuredClone(statement);
  wrongWorkflow.predicate.buildDefinition.externalParameters.workflow.path = "other.yml";
  assert.throws(
    () => validateNpmAuditProvenance(provenanceAudit(expected, wrongWorkflow), expected, source),
    /wrong workflow/u
  );
  const wrongCommit = structuredClone(statement);
  wrongCommit.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
    "f".repeat(40);
  assert.throws(
    () => validateNpmAuditProvenance(provenanceAudit(expected, wrongCommit), expected, source),
    /wrong source commit/u
  );
  const wrongSubject = structuredClone(statement);
  wrongSubject.subject[0]!.digest.sha512 = "f".repeat(128);
  assert.throws(
    () => validateNpmAuditProvenance(provenanceAudit(expected, wrongSubject), expected, source),
    /wrong package bytes/u
  );
  const wrongIdentityStatement = structuredClone(statement);
  wrongIdentityStatement.predicate.buildDefinition.externalParameters.workflow.path =
    "other.yml";
  assert.throws(
    () => validateNpmAuditProvenance(
      provenanceAudit(expected, wrongIdentityStatement),
      expected,
      { ...source, workflowPath: "other.yml" }
    ),
    /wrong signing certificate identity/u
  );
});

function completion(version: string): ReleaseCompletionRef {
  return {
    ref: `refs/tags/released/v${version}`,
    objectType: "commit",
    objectName: COMMIT,
    peeledType: "",
    peeledName: ""
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function publicationMatrix(): readonly NpmPublicationPackage[] {
  return [
    publicationPackage("launcher", RELEASE_LAUNCHER_PACKAGE),
    ...PUBLISHED_ARTIFACT_TARGETS.map((target) => {
      return publicationPackage(target, releaseTargetForArtifact(target).packageName);
    })
  ];
}

function publicationLedger(): NpmPublicationLedger {
  return {
    async status() {
      return "fresh";
    },
    async recordAttempt() {
      return "created";
    }
  };
}

function publicationPackage(
  artifactTarget: NpmPublicationPackage["artifactTarget"],
  name: string
): NpmPublicationPackage {
  return {
    artifactTarget,
    name,
    version: VERSION,
    tarballPath: `/tmp/${artifactTarget}.tgz`,
    sha256: "a".repeat(64),
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`
  };
}

interface ProvenanceStatement {
  _type: string;
  predicateType: string;
  subject: {
    name: string;
    digest: { sha512: string };
  }[];
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: {
        workflow: {
          path: string;
          repository: string;
          ref: string;
        };
      };
      resolvedDependencies: {
        uri: string;
        digest: { gitCommit: string };
      }[];
    };
    runDetails: {
      builder: { id: string };
    };
  };
}

function provenanceStatement(): ProvenanceStatement {
  return {
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
            path: WORKFLOW,
            repository: REPOSITORY,
            ref: SOURCE_REF
          }
        },
        resolvedDependencies: [{
          uri: `git+${REPOSITORY}@${SOURCE_REF}`,
          digest: { gitCommit: COMMIT }
        }]
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" }
      }
    }
  };
}

function provenanceAudit(
  expected: NpmPublicationPackage,
  statement: ProvenanceStatement
): unknown {
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
