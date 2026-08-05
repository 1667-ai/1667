import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubNpmPublicationLedger,
  publicationStatus
} from "../scripts/release-npm-ledger.js";
import {
  validateReleaseCandidate,
  type ReleaseCompletionRef
} from "../scripts/release-completion.js";
import {
  NpmPublicationPendingTimeoutError,
  publishNpmRelease,
  type NpmPublicationLedger,
  type NpmPublicationPackage,
  type NpmPublicationRegistry
} from "../scripts/release-npm-publisher.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../shared/release-targets.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("an attempted package is not republished while its registry wait succeeds", async () => {
  const packages = publicationMatrix();
  const attempted = packages[1]!;
  const present = new Set<string>();
  const published: string[] = [];
  const ledger: NpmPublicationLedger = {
    async assertWritable() {},
    async status(entry) {
      return entry.name === attempted.name ? "attempted" : "fresh";
    },
    async recordAttempt() {
      return "created";
    }
  };
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return present.has(entry.name) ? "present" : "missing";
    },
    async publish(entry) {
      published.push(entry.name);
      present.add(entry.name);
    },
    async waitUntilVerified(entries) {
      for (const entry of entries) present.add(entry.name);
    }
  };
  await publishNpmRelease(packages, registry, ledger);
  assert.ok(!published.includes(attempted.name));
  assert.deepEqual(published, [
    ...packages.slice(2).map((entry) => entry.name),
    packages[0]!.name
  ]);
});

test("the publisher records fresh package bytes before the npm write", async () => {
  const packages = publicationMatrix();
  const events: string[] = [];
  const present = new Set(packages.slice(2).map((entry) => entry.name));
  present.add(packages[0]!.name);
  const ledger: NpmPublicationLedger = {
    async assertWritable() {
      events.push("writable");
    },
    async status() {
      return "fresh";
    },
    async recordAttempt(entry) {
      events.push(`record:${entry.name}`);
      return "created";
    }
  };
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return present.has(entry.name) ? "present" : "missing";
    },
    async publish(entry) {
      events.push(`publish:${entry.name}`);
      present.add(entry.name);
    },
    async waitUntilVerified() {}
  };
  await publishNpmRelease(packages, registry, ledger);
  assert.deepEqual(events, [
    `record:${packages[1]!.name}`,
    "writable",
    `publish:${packages[1]!.name}`
  ]);
});

test("an active operation lease stops immediately before an npm write", async () => {
  const packages = publicationMatrix();
  const missing = packages[1]!;
  const published: string[] = [];
  const ledger: NpmPublicationLedger = {
    async assertWritable() {
      throw new Error("npm operation lease is active");
    },
    async status() {
      return "fresh";
    },
    async recordAttempt() {
      return "created";
    }
  };
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return entry.name === missing.name ? "missing" : "present";
    },
    async publish(entry) {
      published.push(entry.name);
    },
    async waitUntilVerified() {}
  };
  await assert.rejects(
    publishNpmRelease(packages, registry, ledger),
    /operation lease is active/u
  );
  assert.deepEqual(published, []);
});

test("a retry recovers when the process stopped after recording an attempt", async () => {
  const packages = publicationMatrix();
  const recovering = packages[1]!;
  const present = new Set(packages.filter((entry) => entry !== recovering).map((entry) => {
    return entry.name;
  }));
  const events: string[] = [];
  let waits = 0;
  const ledger: NpmPublicationLedger = {
    async assertWritable() {},
    async status(entry) {
      return entry.name === recovering.name ? "attempted" : "fresh";
    },
    async recordAttempt() {
      throw new Error("unreachable");
    }
  };
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return present.has(entry.name) ? "present" : "missing";
    },
    async publish(entry) {
      events.push(`publish:${entry.name}`);
      present.add(entry.name);
    },
    async waitUntilVerified(entries) {
      if (entries.length === 1 && entries[0]?.name === recovering.name) {
        waits += 1;
        events.push(`wait:${waits}`);
        if (waits === 1) {
          throw new NpmPublicationPendingTimeoutError("not visible");
        }
      }
    }
  };
  await publishNpmRelease(packages, registry, ledger);
  assert.deepEqual(events, [
    "wait:1",
    `publish:${recovering.name}`,
    "wait:2"
  ]);
});

test("a protected quarantine marker overrides stale clean registry metadata", async () => {
  const expected = publicationMatrix()[0]!;
  const ref = `refs/tags/released/v${VERSION}_quarantined`;
  assert.throws(() => publicationStatus([{
    ref,
    object: { type: "commit", sha: COMMIT }
  }], expected, COMMIT), /quarantined/u);
});

test("the GitHub ledger records exact bytes before it authorizes publication", async () => {
  const expected = publicationMatrix()[0]!;
  const calls: { method: string; body: unknown }[] = [];
  const verifiedVersions: string[] = [];
  let refs: unknown[] = [];
  const ledger = new GitHubNpmPublicationLedger({
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "test-token",
    verifyReleaseTag: async (version) => {
      verifiedVersions.push(version);
    },
    fetch: async (_input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body))
      });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { ref: string; sha: string };
        const created = { ref: body.ref, object: { type: "commit", sha: body.sha } };
        refs = [created];
        return jsonResponse(created, 201);
      }
      return jsonResponse(refs, 200);
    }
  });
  assert.equal(await ledger.recordAttempt(expected), "created");
  await ledger.assertWritable(expected);
  assert.deepEqual(verifiedVersions, [VERSION]);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
  assert.deepEqual(calls[1]?.body, {
    ref: `refs/tags/released/v${VERSION}_attempt_launcher_${expected.sha256}`,
    sha: COMMIT
  });
});

test("the release tag is verified at each npm write boundary", async () => {
  const packages = publicationMatrix();
  const missing = new Set(packages.slice(1, 3).map((entry) => entry.name));
  const present = new Set(packages.filter((entry) => !missing.has(entry.name)).map((entry) => {
    return entry.name;
  }));
  const published: string[] = [];
  let refs: unknown[] = [];
  let verifications = 0;
  const ledger = new GitHubNpmPublicationLedger({
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "test-token",
    verifyReleaseTag: async () => {
      verifications += 1;
      if (verifications === 2) throw new Error("release tag moved");
    },
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { ref: string; sha: string };
        const created = { ref: body.ref, object: { type: "commit", sha: body.sha } };
        refs = [...refs, created];
        return jsonResponse(created, 201);
      }
      return jsonResponse(refs, 200);
    }
  });
  const registry: NpmPublicationRegistry = {
    async inspect(entry) {
      return present.has(entry.name) ? "present" : "missing";
    },
    async publish(entry) {
      published.push(entry.name);
      present.add(entry.name);
    },
    async waitUntilVerified() {}
  };

  await assert.rejects(
    publishNpmRelease(packages, registry, ledger),
    /release tag moved/u
  );
  assert.deepEqual(published, [packages[1]!.name]);
  assert.equal(verifications, 2);
});

test("the GitHub ledger refuses a different created attempt ref", async () => {
  const expected = publicationMatrix()[0]!;
  const ledger = new GitHubNpmPublicationLedger({
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "test-token",
    verifyReleaseTag: async () => {},
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse({
          ref: `refs/tags/released/v${VERSION}_attempt_launcher_${"f".repeat(64)}`,
          object: { type: "commit", sha: COMMIT }
        }, 201);
      }
      return jsonResponse([], 200);
    }
  });
  await assert.rejects(
    ledger.recordAttempt(expected),
    /created the wrong publication attempt/u
  );
});

test("the workflow write gate does not require repository administration", async () => {
  const expected = publicationMatrix()[0]!;
  const requested: string[] = [];
  const ledger = new GitHubNpmPublicationLedger({
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "workflow-token",
    verifyReleaseTag: async () => {},
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      if (new URL(url).pathname.includes("/rulesets")) {
        return jsonResponse({ message: "forbidden" }, 403);
      }
      return jsonResponse([], 200);
    }
  });

  await ledger.assertWritable(expected);
  assert.equal(requested.some((url) => url.includes("/rulesets")), false);
});

test("the GitHub write gate freshly rejects a quarantine marker", async () => {
  const expected = publicationMatrix()[0]!;
  const ledger = new GitHubNpmPublicationLedger({
    repository: "1667-ai/1667",
    sourceCommit: COMMIT,
    token: "test-token",
    verifyReleaseTag: async () => {},
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      return jsonResponse(pathname.includes("/tags/released/")
        ? [{
          ref: `refs/tags/released/v${VERSION}_quarantined`,
          object: { type: "commit", sha: COMMIT }
        }]
        : [], 200);
    }
  });
  await assert.rejects(ledger.assertWritable(expected), /quarantined/u);
});

test("a conflicting publication attempt cannot authorize different bytes", () => {
  const expected = publicationMatrix()[0]!;
  assert.throws(() => publicationStatus([{
    ref: `refs/tags/released/v${VERSION}_attempt_launcher_${"f".repeat(64)}`,
    object: { type: "commit", sha: COMMIT }
  }], expected, COMMIT), /different attempt/u);
});

test("release ordering accepts exact attempts and refuses quarantine", () => {
  const expected = publicationMatrix()[0]!;
  const attempt = releaseRef(
    `refs/tags/released/v${VERSION}_attempt_launcher_${expected.sha256}`
  );
  validateReleaseCandidate(VERSION, COMMIT, [attempt]);
  assert.throws(
    () => validateReleaseCandidate(VERSION, COMMIT, [
      releaseRef(`refs/tags/released/v${VERSION}_quarantined`)
    ]),
    /quarantined/u
  );
  assert.throws(
    () => validateReleaseCandidate(VERSION, COMMIT, [
      { ...attempt, objectName: "f".repeat(40) }
    ]),
    /different commit/u
  );
});

function publicationMatrix(): readonly NpmPublicationPackage[] {
  return [
    publicationPackage("launcher", RELEASE_LAUNCHER_PACKAGE),
    ...PUBLISHED_ARTIFACT_TARGETS.map((target) => {
      return publicationPackage(target, releaseTargetForArtifact(target).packageName);
    })
  ];
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

function releaseRef(ref: string): ReleaseCompletionRef {
  return {
    ref,
    objectType: "commit",
    objectName: COMMIT,
    peeledType: "",
    peeledName: ""
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}
