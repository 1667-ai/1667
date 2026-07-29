import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { RELEASE_LAUNCHER_PACKAGE } from "../shared/release-targets.js";
import {
  NpmTagOperationJournal
} from "../scripts/release-npm-operation-journal.js";
import {
  NPM_OPERATION_JOURNAL_MAX_BYTES,
  NPM_OPERATION_JOURNAL_MAX_RECORDS
} from "../scripts/release-npm-operation-journal-limits.js";
import {
  readNpmOperationJournal
} from "../scripts/release-npm-operation-journal-reader.js";
import {
  PublicNpmTagRegistry,
  type NpmTagMetadataClient
} from "../scripts/release-npm-tag-registry.js";
import {
  npmReleaseOperationPackageOrder,
  type NpmPackageTagState
} from "../scripts/release-npm-operations.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(
  new URL("../scripts/release-npm-operations-cli.ts", import.meta.url)
);
const VERSION = "1.2.3";
const OTHER_VERSION = "1.2.2";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MAINTAINERS = [{ name: "1667.ai", email: "npm@1667.ai" }] as const;
const JOURNAL_IDENTITY = {
  runId: "12345",
  runAttempt: "2",
  operation: "promotion",
  version: VERSION,
  sourceCommit: SOURCE_COMMIT,
  parameters: {
    operation: "promotion",
    promotion: {
      destination: "latest",
      stableAcknowledged: false
    }
  }
} as const;

test("the CLI refuses an operation without exact lease coordinates", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-journal-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  const evidence = path.join(root, "evidence.json");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import",
      "tsx",
      CLI,
      "promote",
      "not-semver",
      evidence
    ], {
      env: {
        PATH: process.env.PATH,
        npm_node_execpath: process.execPath,
        npm_execpath: npmCli
      }
    }),
    /run-id.*run-attempt.*source-commit/u
  );
  await assert.rejects(readFile(evidence), { code: "ENOENT" });
});

test("a failed operation journal retains progress and observations", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-journal-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, "evidence.json");
  const state = packageState(VERSION);
  const journal = new NpmTagOperationJournal(
    evidence,
    JOURNAL_IDENTITY,
    [RELEASE_LAUNCHER_PACKAGE]
  );
  journal.record({ kind: "before", states: [state] });
  journal.record({
    kind: "write-attempt",
    write: {
      kind: "add",
      name: RELEASE_LAUNCHER_PACKAGE,
      version: VERSION,
      tag: "latest"
    }
  });
  journal.fail("simulated failure", [state], []);
  journal.close();
  const records = await journalRecords(evidence);
  assert.deepEqual(
    records.map((record) => record.record),
    ["started", "event", "event", "failed"]
  );
  assert.deepEqual(
    records
      .filter((record) => record.record === "event")
      .map((record) => record.event?.kind),
    ["before", "write-attempt"]
  );
  assert.equal(records[3]?.failure?.message, "simulated failure");
  assert.deepEqual(records[3]?.failure?.observed, [state]);
  for (const record of records) {
    assert.equal(record.runId, JOURNAL_IDENTITY.runId);
    assert.equal(record.runAttempt, JOURNAL_IDENTITY.runAttempt);
    assert.equal(record.operation, JOURNAL_IDENTITY.operation);
    assert.equal(record.version, JOURNAL_IDENTITY.version);
    assert.equal(record.sourceCommit, JOURNAL_IDENTITY.sourceCommit);
    assert.deepEqual(record.parameters, JOURNAL_IDENTITY.parameters);
    assert.equal(Object.hasOwn(record, "claimSecret"), false);
  }
});

test("journal bounds retain a readable pending write", async (t) => {
  for (const [name, options] of [
    ["byte", { maxBytes: 16 * 1024 }],
    ["record", { maxRecords: 3 }]
  ] as const) {
    await t.test(name, async (t) => {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "1667-npm-journal-bound-"))
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const evidence = path.join(root, "evidence.json");
      const order = npmReleaseOperationPackageOrder("promotion");
      const states = order.map((packageName) => packageStateFor(packageName, VERSION));
      const write = {
        kind: "add",
        name: order[0]!,
        version: VERSION,
        tag: "latest"
      } as const;
      const journal = new NpmTagOperationJournal(
        evidence,
        JOURNAL_IDENTITY,
        order,
        options
      );
      journal.record({ kind: "before", states });
      journal.record({ kind: "write-attempt", write });
      assert.throws(
        () => journal.record({
          kind: "write-verified",
          write,
          state: {
            ...states[0]!,
            deprecated: "x".repeat(32 * 1024)
          }
        }),
        new RegExp(`recovery ${name} bound`, "u")
      );
      journal.close();

      const recovered = readNpmOperationJournal(evidence, JOURNAL_IDENTITY);
      assert.equal(recovered.terminal, null);
      assert.equal(recovered.writeAttempts, 1);
    });
  }
});

test("a journal cannot weaken the recovery bounds", async (t) => {
  for (const [name, options] of [
    ["byte", { maxBytes: NPM_OPERATION_JOURNAL_MAX_BYTES + 1 }],
    ["record", { maxRecords: NPM_OPERATION_JOURNAL_MAX_RECORDS + 1 }]
  ] as const) {
    await t.test(name, async () => {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "1667-npm-journal-limit-"))
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const evidence = path.join(root, "evidence.json");
      assert.throws(
        () => new NpmTagOperationJournal(
          evidence,
          JOURNAL_IDENTITY,
          npmReleaseOperationPackageOrder("promotion"),
          options
        ),
        new RegExp(`${name} bound is invalid`, "u")
      );
      await assert.rejects(readFile(evidence), { code: "ENOENT" });
    });
  }
});

test("an indeterminate npm failure reconciles against public state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  const argumentsFile = path.join(root, "arguments.json");
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify({`,
    "  arguments: process.argv.slice(2),",
    "  githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,",
    "  claimSecret: process.env.NPM_OPERATION_CLAIM_SECRET,",
    "  writerSecret: process.env.NPM_OPERATION_WRITER_SECRET,",
    "}));",
    "process.exitCode = 1;",
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);
  let authorizations = 0;
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: {
      ...npmEnvironment(npmCli),
      GH_TOKEN: "lease-token",
      GITHUB_TOKEN: "workflow-token",
      NPM_OPERATION_CLAIM_SECRET: "claim",
      NPM_OPERATION_WRITER_SECRET: "writer"
    },
    authorizeWrite: async () => {
      authorizations += 1;
    },
    metadata: new StaticMetadata(VERSION)
  });
  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.equal(authorizations, 1);
  const result = JSON.parse(await readFile(argumentsFile, "utf8")) as {
    readonly arguments: string[];
    readonly githubToken?: string;
    readonly claimSecret?: string;
    readonly writerSecret?: string;
  };
  const arguments_ = result.arguments;
  assert.ok(arguments_.includes("--registry=https://registry.npmjs.org/"));
  assert.ok(arguments_.includes("--@1667-ai:registry=https://registry.npmjs.org/"));
  assert.equal(result.githubToken, undefined);
  assert.equal(result.claimSecret, undefined);
  assert.equal(result.writerSecret, undefined);
});

test("an unconfirmed npm failure stops after bounded reconciliation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await chmod(npmCli, 0o755);
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: new StaticMetadata(OTHER_VERSION),
    settleTimeoutMs: 3,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });
  await assert.rejects(
    registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest"),
    /was not confirmed by npm/u
  );
  assert.equal(now, 3);
});

test("registry reconciliation can confirm a write after more than 30 seconds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-delayed-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await chmod(npmCli, 0o755);
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: new DelayedMetadata(() => now),
    settleTimeoutMs: 60_000,
    pollIntervalMs: 10_000,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });
  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.equal(now, 40_000);
});

test("default visibility wait confirms a write after the command bound", async () => {
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {},
    runner: { async run() {} },
    metadata: new DelayedMetadata(() => now, 5 * 60_000),
    pollIntervalMs: 60_000,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });
  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.equal(now, 6 * 60_000);
});

test("registry inspection preserves a __proto__ dist-tag", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-prototype-tag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await chmod(npmCli, 0o755);
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: new PrototypeTagMetadata()
  });
  const state = await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION);
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.tags, "__proto__"),
    true
  );
  assert.equal(state.tags["__proto__"], VERSION);
});

test("registry inspection models exact-version absence explicitly", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-absent-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await chmod(npmCli, 0o755);
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: {
      async read(name: string, version: string | null): Promise<unknown | null> {
        return version === null
          ? { name, maintainers: MAINTAINERS, "dist-tags": { latest: OTHER_VERSION } }
          : null;
      }
    }
  });
  const state = await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION);
  assert.equal(state.name, RELEASE_LAUNCHER_PACKAGE);
  assert.equal(state.version, VERSION);
  assert.equal(state.present, false);
  assert.equal(state.deprecated, null);
  assert.deepEqual({ ...state.tags }, { latest: OTHER_VERSION });
});

test("registry inspection models a wholly absent package explicitly", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-npm-absent-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  await chmod(npmCli, 0o755);
  const registry = new PublicNpmTagRegistry({
    ...await processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: {
      async read(): Promise<null> {
        return null;
      }
    }
  });

  const state = await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION);
  assert.equal(state.name, RELEASE_LAUNCHER_PACKAGE);
  assert.equal(state.version, VERSION);
  assert.equal(state.present, false);
  assert.equal(state.deprecated, null);
  assert.deepEqual({ ...state.tags }, {});
  assert.equal(Object.getPrototypeOf(state.tags), null);
  assert.equal(Object.isFrozen(state.tags), true);
});

class StaticMetadata implements NpmTagMetadataClient {
  readonly #latest: string;

  constructor(latest: string) {
    this.#latest = latest;
  }

  async read(
    name: string,
    version: string | null
  ): Promise<unknown> {
    return version === null
      ? {
          name,
          maintainers: MAINTAINERS,
          "dist-tags": { latest: this.#latest, next: VERSION }
        }
      : { name, version };
  }
}

class DelayedMetadata implements NpmTagMetadataClient {
  readonly #now: () => number;
  readonly #visibleAfter: number;

  constructor(now: () => number, visibleAfter = 30_000) {
    this.#now = now;
    this.#visibleAfter = visibleAfter;
  }

  async read(name: string, version: string | null): Promise<unknown> {
    return version === null
        ? {
          name,
          maintainers: MAINTAINERS,
          "dist-tags": {
            latest: this.#now() > this.#visibleAfter ? VERSION : OTHER_VERSION,
            next: VERSION
          }
        }
      : { name, version };
  }
}

class PrototypeTagMetadata implements NpmTagMetadataClient {
  async read(name: string, version: string | null): Promise<unknown> {
    return version === null
      ? JSON.parse(
          `{"name":${JSON.stringify(name)},`
          + `"maintainers":[{"name":"1667.ai","email":"npm@1667.ai"}],`
          + `"dist-tags":{"__proto__":${JSON.stringify(VERSION)}}}`
        )
      : { name, version };
  }
}

function npmEnvironment(npmCli: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    npm_node_execpath: process.execPath,
    npm_execpath: npmCli
  };
}

async function processOptions(root: string): Promise<{
  processJournalPath: string;
  processIdentity: {
    runId: string;
    runAttempt: string;
    operation: "promotion";
    version: string;
    sourceCommit: string;
  };
}> {
  return {
    processJournalPath: path.join(await realpath(root), "processes.jsonl"),
    processIdentity: {
      runId: JOURNAL_IDENTITY.runId,
      runAttempt: JOURNAL_IDENTITY.runAttempt,
      operation: JOURNAL_IDENTITY.operation,
      version: JOURNAL_IDENTITY.version,
      sourceCommit: JOURNAL_IDENTITY.sourceCommit
    }
  };
}

function packageState(latest: string): NpmPackageTagState {
  return packageStateFor(RELEASE_LAUNCHER_PACKAGE, latest);
}

function packageStateFor(name: string, latest: string): NpmPackageTagState {
  return {
    name,
    version: VERSION,
    present: true,
    deprecated: null,
    tags: { latest, next: VERSION }
  };
}

async function journalRecords(file: string): Promise<JournalRecord[]> {
  return (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as JournalRecord;
  });
}

interface JournalRecord {
  readonly record: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly operation: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly parameters: unknown;
  readonly event?: { readonly kind: string };
  readonly failure?: {
    readonly message: string;
    readonly observed: readonly NpmPackageTagState[];
  };
}
