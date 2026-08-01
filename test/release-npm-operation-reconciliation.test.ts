import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
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
import { canonicalJson } from "../server/canonical-json.js";
import {
  PUBLISHED_PACKAGE_COUNT,
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  NpmTagOperationJournal,
  type NpmTagOperationJournalIdentity
} from "../scripts/release-npm-operation-journal.js";
import {
  reconcileNpmTagOperation,
  type NpmOperationReconciliationIdentity
} from "../scripts/release-npm-operation-reconciliation.js";
import { PublicNpmTagRegistry } from
  "../scripts/release-npm-tag-registry.js";
import {
  assertNoNpmOperationCredentialEnvironment,
  NPM_PUBLIC_REGISTRY,
  npmQuarantineMessage,
  npmReleaseOperationPackageOrder,
  npmTagWriteArguments,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const OTHER_VERSION = "1.2.2";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PROMOTION_PARAMETERS = {
  operation: "promotion",
  promotion: {
    destination: "latest",
    stableAcknowledged: false
  }
} as const;
const QUARANTINE_PARAMETERS = {
  operation: "quarantine",
  quarantine: {
    incidentReference: "https://github.com/1667-ai/1667/issues/111",
    supersedingVersion: "1.2.4"
  }
} as const;
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(
  new URL("../scripts/release-npm-operations-cli.ts", import.meta.url)
);
test("operation journals append and never truncate durable records", async () => {
  const source = await readFile(
    new URL("../scripts/release-npm-operation-journal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /constants\.O_APPEND/u);
  assert.doesNotMatch(source, /ftruncate|truncateSync/u);
});
test("operation journals sync the new directory entry", async () => {
  const source = await readFile(
    new URL("../scripts/release-npm-operation-journal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /fsyncSync\(directoryDescriptor\)/u);
  const startedRecord = source.indexOf('record: "started"');
  const directorySync = source.indexOf("syncDirectory(reservation.parent);");
  assert.ok(
    startedRecord !== -1 && directorySync > startedRecord,
    "journal creation must sync its parent after the started record"
  );
});
test("tag writes pin the public registry and accept no OTP", () => {
  const commands = [
    npmTagWriteArguments({
      kind: "add", name: RELEASE_LAUNCHER_PACKAGE, version: VERSION, tag: "stable"
    }),
    npmTagWriteArguments({
      kind: "remove", name: RELEASE_LAUNCHER_PACKAGE, version: VERSION, tag: "next"
    }),
    npmTagWriteArguments({
      kind: "deprecate",
      name: RELEASE_LAUNCHER_PACKAGE,
      version: VERSION,
      message: npmQuarantineMessage(QUARANTINE_PARAMETERS.quarantine)
    })
  ];
  for (const command of commands) {
    assert.ok(command.includes(`--registry=${NPM_PUBLIC_REGISTRY}`));
    assert.ok(command.includes(`--@1667-ai:registry=${NPM_PUBLIC_REGISTRY}`));
    assert.doesNotMatch(command.join(" "), /(?:otp|token)/iu);
  }
});
test("registry tag names stay after npm option parsing ends", () => {
  const command = npmTagWriteArguments({
    kind: "remove",
    name: RELEASE_LAUNCHER_PACKAGE,
    version: VERSION,
    tag: "--offline"
  });
  const delimiter = command.indexOf("--");
  assert.ok(delimiter > command.indexOf("rm"));
  assert.deepEqual(command.slice(delimiter + 1), [
    RELEASE_LAUNCHER_PACKAGE,
    "--offline"
  ]);
  assert.ok(command.indexOf(`--registry=${NPM_PUBLIC_REGISTRY}`) < delimiter);
  assert.ok(
    command.indexOf(`--@1667-ai:registry=${NPM_PUBLIC_REGISTRY}`) < delimiter
  );
});
test("tag operations refuse ambient tokens and OTPs", () => {
  for (const variable of [
    "NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_AUTH_TOKEN", "NPM_CONFIG_OTP",
    "NPM_CONFIG__AUTH", "NPM_CONFIG__AUTHTOKEN", "NPM_CONFIG__PASSWORD",
    "npm_config_//registry.npmjs.org/:_authToken",
    "npm_config_//registry.npmjs.org/:_password", "NPM_OTP", "OTP"
  ]) {
    assert.throws(
      () => assertNoNpmOperationCredentialEnvironment({ [variable]: "secret" }),
      new RegExp(variable, "u")
    );
  }
});
test("operation package order rejects an unknown operation", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import", "tsx", CLI, "packages", "publish"
    ]),
    /usage: release-npm-operations-cli\.ts packages/u
  );
});
test("public maintainer metadata does not authorize npm writes", async (t) => {
  const root = await realRoot(t);
  const npmCli = path.join(root, "npm.cjs");
  await writeFile(npmCli, "process.exitCode = 1;\n");
  const registry = new PublicNpmTagRegistry({
    environment: {
      PATH: process.env.PATH,
      npm_node_execpath: process.execPath,
      npm_execpath: npmCli
    },
    authorizeWrite: async () => {},
    metadata: {
      async read(name: string, version: string | null): Promise<unknown> {
        return version === null
          ? {
              name,
              maintainers: [{ name: "other", email: "other@example.com" }],
              "dist-tags": {}
            }
          : { name, version };
      }
    }
  });
  const state = await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION);
  assert.equal(state.name, RELEASE_LAUNCHER_PACKAGE);
  assert.equal(state.present, true);
});
test("a retarget before removal prevents the npm rm process", async (t) => {
  const root = await realRoot(t);
  const npmCli = path.join(root, "npm.cjs");
  const spawned = path.join(root, "spawned");
  await writeFile(
    npmCli,
    `require("node:fs").writeFileSync(${JSON.stringify(spawned)}, "yes");\n`
  );
  let packumentReads = 0;
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    environment: {
      PATH: process.env.PATH,
      npm_node_execpath: process.execPath,
      npm_execpath: npmCli
    },
    authorizeWrite: async () => {},
    runner: {
      async run(): Promise<void> {
        await writeFile(spawned, "yes");
      }
    },
    settleTimeoutMs: 2,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    metadata: {
      async read(name: string, version: string | null): Promise<unknown> {
        if (version !== null) return { name, version };
        packumentReads += 1;
        return {
          name,
          maintainers: [{ name: "1667.ai", email: "npm@1667.ai" }],
          "dist-tags": {
            latest: packumentReads === 1 ? VERSION : OTHER_VERSION
          }
        };
      }
    }
  });
  assert.equal(
    (await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION)).tags.latest,
    VERSION
  );
  await assert.rejects(
    registry.removeTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest"),
    /latest tag changed before removal/u
  );
  await assert.rejects(readFile(spawned), { code: "ENOENT" });
});

test("registry removal clears a live tag while the exact version is absent", async () => {
  const tags: Record<string, string> = { latest: VERSION };
  const writes: string[][] = [];
  let applyWrite = true;
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {},
    metadata: {
      async read(name: string, version: string | null): Promise<unknown> {
        return version === null
          ? {
              name,
              maintainers: [{ name: "1667.ai", email: "npm@1667.ai" }],
              "dist-tags": { ...tags }
            }
          : null;
      }
    },
    runner: {
      async run(arguments_: readonly string[]): Promise<void> {
        writes.push([...arguments_]);
        if (applyWrite) delete tags.latest;
      }
    },
    settleTimeoutMs: 2,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  await registry.removeTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.equal(writes.length, 1);
  assert.deepEqual(tags, {});

  tags.latest = VERSION;
  applyWrite = false;
  await assert.rejects(
    registry.removeTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest"),
    /was not confirmed by npm/u
  );
  assert.equal(tags.latest, VERSION);
});

test("reconciliation emits complete, retry, and safe verdicts from public state", async (t) => {
  const root = await realRoot(t);
  const safeJournal = await startedJournal(root, "safe.jsonl", promotionIdentity());
  const safe = await reconcileNpmTagOperation(
    safeJournal,
    expected("promotion"),
    new StaticRegistry(promotionStates(OTHER_VERSION))
  );
  assert.equal(safe.verdict, "safe-to-abandon");
  assert.equal(safe.journal.terminal, null);

  const partial = promotionStates(OTHER_VERSION);
  partial.get(PUBLISHED_PLATFORM_PACKAGES[0]!)!.tags.latest = VERSION;
  const retry = await reconcileNpmTagOperation(
    safeJournal,
    expected("promotion"),
    new StaticRegistry(partial)
  );
  assert.equal(retry.verdict, "retry-required");

  const complete = await reconcileNpmTagOperation(
    safeJournal,
    expected("promotion"),
    new StaticRegistry(promotionStates(VERSION))
  );
  assert.equal(complete.verdict, "complete");
});

test("quarantine reconciliation includes absent exact versions as complete", async (t) => {
  const root = await realRoot(t);
  const journal = await startedJournal(root, "quarantine.jsonl", quarantineIdentity());
  const input = promotionStates(OTHER_VERSION);
  for (const [index, state] of [...input.values()].entries()) {
    if (index < 2) {
      state.tags = {};
      state.deprecated = npmQuarantineMessage(QUARANTINE_PARAMETERS.quarantine);
    } else {
      state.present = false;
      state.tags = {};
    }
  }
  const result = await reconcileNpmTagOperation(
    journal,
    expected("quarantine"),
    new StaticRegistry(input)
  );
  assert.equal(result.verdict, "complete");
  assert.equal(result.observed.length, PUBLISHED_PACKAGE_COUNT);
  assert.equal(
    result.observed.filter((state) => !state.present).length,
    PUBLISHED_PACKAGE_COUNT - 2
  );

  input.get(RELEASE_LAUNCHER_PACKAGE)!.tags.latest = VERSION;
  const unsafe = await reconcileNpmTagOperation(
    journal,
    expected("quarantine"),
    new StaticRegistry(input)
  );
  assert.equal(unsafe.verdict, "retry-required");
});

test("a journal write attempt makes an incomplete promotion require retry", async (t) => {
  const root = await realRoot(t);
  const file = path.join(root, "attempt.jsonl");
  const order = npmReleaseOperationPackageOrder("promotion");
  const states = [...promotionStates(OTHER_VERSION).values()].map(frozenState);
  const journal = new NpmTagOperationJournal(file, promotionIdentity(), order);
  journal.record({ kind: "before", states });
  journal.record({
    kind: "write-attempt",
    write: {
      kind: "add",
      name: order[0]!,
      version: VERSION,
      tag: "latest"
    }
  });
  journal.close();
  const result = await reconcileNpmTagOperation(
    file,
    expected("promotion"),
    new StaticRegistry(promotionStates(OTHER_VERSION))
  );
  assert.equal(result.verdict, "retry-required");
  assert.equal(result.journal.writeAttempts, 1);
});

test("journal parsing rejects identity, order, duplicates, truncation, and tail records", async (t) => {
  const root = await realRoot(t);
  const base = await startedJournal(root, "base.jsonl", promotionIdentity());
  await assert.rejects(
    reconcileNpmTagOperation(
      base,
      { ...expected("promotion"), runId: "999" },
      new StaticRegistry(promotionStates(OTHER_VERSION))
    ),
    /wrong lease identity/u
  );

  const line = (await readFile(base, "utf8")).trimEnd();
  const duplicate = path.join(root, "duplicate.jsonl");
  await writeFile(duplicate, `${line}\n${line}\n`);
  await assert.rejects(reconcile(duplicate), /repeats a record/u);

  const truncated = path.join(root, "truncated.jsonl");
  await writeFile(truncated, line);
  await assert.rejects(reconcile(truncated), /truncated final record/u);

  const noncanonical = path.join(root, "noncanonical.jsonl");
  await writeFile(noncanonical, ` ${line}\n`);
  await assert.rejects(reconcile(noncanonical), /not canonical JSON/u);

  const parsed = JSON.parse(line) as Record<string, unknown>;
  parsed.packageOrder = [...npmReleaseOperationPackageOrder("promotion")].reverse();
  const wrongOrder = path.join(root, "wrong-order.jsonl");
  await writeFile(wrongOrder, `${canonicalJson(parsed)}\n`);
  await assert.rejects(reconcile(wrongOrder), /invalid started record/u);

  const wrongFailure = path.join(root, "wrong-failure-order.jsonl");
  const failed = new NpmTagOperationJournal(
    wrongFailure, promotionIdentity(), npmReleaseOperationPackageOrder("promotion")
  );
  failed.fail("stopped", [...promotionStates(OTHER_VERSION).values()]
    .reverse().map(frozenState), []);
  failed.close();
  await assert.rejects(reconcile(wrongFailure), /observations are out of order/u);

  const terminal = path.join(root, "terminal.jsonl");
  const order = npmReleaseOperationPackageOrder("promotion");
  const states = [...promotionStates(OTHER_VERSION).values()].map(frozenState);
  const journal = new NpmTagOperationJournal(terminal, promotionIdentity(), order);
  journal.fail("stopped", states, []);
  journal.close();
  const tail = JSON.parse(line) as Record<string, unknown>;
  delete tail.registry;
  delete tail.packageOrder;
  tail.record = "event";
  tail.event = { kind: "before", states };
  await appendFile(terminal, `${canonicalJson(tail)}\n`);
  await assert.rejects(reconcile(terminal), /record after its terminal/u);

  async function reconcile(file: string): Promise<unknown> {
    return reconcileNpmTagOperation(
      file,
      expected("promotion"),
      new StaticRegistry(promotionStates(OTHER_VERSION))
    );
  }
});

class StaticRegistry implements NpmTagRegistry {
  readonly #states: Map<string, MutableState>;
  constructor(states: Map<string, MutableState>) {
    this.#states = states;
  }
  async settleAbsence(): Promise<void> {}
  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    const state = this.#states.get(name);
    if (state === undefined) throw new Error(`missing ${name}`);
    return frozenState({ ...state, name, version });
  }
  async addTag(): Promise<void> {
    throw new Error("reconciliation must not write");
  }
  async removeTag(): Promise<void> {
    throw new Error("reconciliation must not write");
  }
  async deprecate(): Promise<void> {
    throw new Error("reconciliation must not write");
  }
}

interface MutableState {
  name: string;
  version: string;
  present: boolean;
  deprecated: string | null;
  tags: Record<string, string>;
}

function promotionStates(latest: string): Map<string, MutableState> {
  return new Map([
    ...PUBLISHED_PLATFORM_PACKAGES,
    RELEASE_LAUNCHER_PACKAGE
  ].map((name) => [name, {
    name,
    version: VERSION,
    present: true,
    deprecated: null,
    tags: { latest, next: VERSION }
  }]));
}

function frozenState(state: MutableState): NpmPackageTagState {
  return Object.freeze({
    ...state,
    tags: Object.freeze({ ...state.tags })
  });
}

function expected(operation: "promotion" | "quarantine"): NpmOperationReconciliationIdentity {
  return {
    runId: "12345",
    runAttempt: "2",
    operation,
    version: VERSION,
    sourceCommit: SOURCE_COMMIT
  };
}

function promotionIdentity(): NpmTagOperationJournalIdentity {
  return { ...expected("promotion"), parameters: PROMOTION_PARAMETERS };
}

function quarantineIdentity(): NpmTagOperationJournalIdentity {
  return { ...expected("quarantine"), parameters: QUARANTINE_PARAMETERS };
}

async function startedJournal(
  root: string,
  name: string,
  identity: NpmTagOperationJournalIdentity
): Promise<string> {
  const file = path.join(root, name);
  const journal = new NpmTagOperationJournal(
    file,
    identity,
    npmReleaseOperationPackageOrder(identity.operation)
  );
  journal.close();
  return file;
}

async function realRoot(t: test.TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-operation-reconciliation-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
