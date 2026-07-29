import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import {
  inspectNpmProcessQuiescence,
  NpmProcessJournal,
  type NpmProcessJournalIdentity,
  type NpmProcessToolIdentity
} from "../scripts/release-npm-process-journal.js";
import {
  runNpmTagOperation, type NpmTagOperationLease
} from "../scripts/release-npm-operations-cli.js";
import type {
  NpmPackageTagState, NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const execFileAsync = promisify(execFile);
const PROCESS_CLI = path.resolve("scripts/release-npm-process-cli.ts");
const IDENTITY: NpmProcessJournalIdentity = Object.freeze({
  runId: "12345",
  runAttempt: "2",
  operation: "promotion",
  version: VERSION,
  sourceCommit: COMMIT
});

test("recovery quiescence blocks a live operation owner", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  assert.equal(
    inspectNpmProcessQuiescence(journal.path, IDENTITY).ownerActive,
    false
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import", "tsx", PROCESS_CLI, "quiescent", journal.path,
      IDENTITY.runId, IDENTITY.runAttempt, IDENTITY.operation,
      IDENTITY.version, IDENTITY.sourceCommit
    ]),
    /npm operation owner \d+ is active/u
  );
});

test("recovery quiescence accepts an exited operation owner", async (t) => {
  const root = await temporaryRoot(t);
  const journalPath = path.join(root, "process.jsonl");
  const moduleUrl = pathToFileURL(
    path.resolve("scripts/release-npm-process-journal.ts")
  ).href;
  await execFileAsync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { NpmProcessJournal } from ${JSON.stringify(moduleUrl)};
new NpmProcessJournal(process.argv[1], JSON.parse(process.argv[2]));`,
    journalPath,
    JSON.stringify(IDENTITY)
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx", PROCESS_CLI, "quiescent", journalPath,
    IDENTITY.runId, IDENTITY.runAttempt, IDENTITY.operation,
    IDENTITY.version, IDENTITY.sourceCommit
  ]);
  assert.match(stdout, /"quiescent":true/u);
});

test("journal validation rejects changed lease and command identity", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  assert.throws(
    () => inspectNpmProcessQuiescence(journal.path, {
      ...IDENTITY,
      version: "1.2.4"
    }),
    /coordinates changed/u
  );
  assert.throws(() => journal.started({
    pid: process.pid,
    nonce: "a".repeat(64),
    tool: fakeToolIdentity(),
    arguments: ["dist-tag"],
    npmCommand: ["/wrong/tool", "dist-tag"]
  }), /does not bind its tool and nonce/u);
});

test("the process journal stays inside its recovery size bound", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  let rejected = false;
  for (let index = 0; index < 32; index += 1) {
    const nonce = index.toString(16).padStart(64, "0");
    const started = largeStarted(nonce, 2, 14 * 1024);
    try {
      journal.started(started);
      journal.terminal({
        pid: started.pid,
        nonce,
        outcome: "success",
        code: 0,
        signal: null
      });
    } catch (error) {
      assert.match(String(error), /recovery size bound/u);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true);
  assert.ok(statSync(journal.path).size <= 1024 * 1024);
  assert.doesNotThrow(() => inspectNpmProcessQuiescence(journal.path, IDENTITY));
});

test("the process journal rejects a line its recovery reader cannot read", async (t) => {
  const root = await temporaryRoot(t);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  assert.throws(
    () => journal.started(largeStarted("e".repeat(64), 3, 12 * 1024)),
    /line exceeds the recovery bound/u
  );
  assert.throws(
    () => journal.started(largeStarted("f".repeat(64), 1, 16)),
    /refuses writes after an append failure/u
  );
  assert.doesNotThrow(() => inspectNpmProcessQuiescence(journal.path, IDENTITY));
});

test("journal reader rejects a torn tail and unexpected record fields", async (t) => {
  const root = await temporaryRoot(t);
  const tool = fakeToolIdentity();
  const nonce = "a".repeat(64);
  const started = {
    pid: process.pid,
    nonce,
    tool,
    arguments: ["dist-tag"],
    npmCommand: [
      tool.node.path,
      tool.npmCli.path,
      `--user-agent=1667-npm-operation-${nonce}`,
      "dist-tag"
    ]
  };
  const torn = new NpmProcessJournal(path.join(root, "torn.jsonl"), IDENTITY);
  torn.started(started);
  await appendFile(torn.path, canonicalJson({
    schemaVersion: 1,
    record: "terminal",
    ...IDENTITY,
    pid: process.pid,
    nonce,
    outcome: "success",
    code: 0,
    signal: null
  }));
  assert.throws(
    () => inspectNpmProcessQuiescence(torn.path, IDENTITY),
    /incomplete final record/u
  );
  const extended = new NpmProcessJournal(
    path.join(root, "extended.jsonl"),
    IDENTITY
  );
  await writeFile(extended.path, `${canonicalJson({
    schemaVersion: 1,
    record: "opened",
    ...IDENTITY,
    ownerPid: process.pid,
    unexpected: true
  })}\n`);
  assert.throws(
    () => inspectNpmProcessQuiescence(extended.path, IDENTITY),
    /opened fields are invalid/u
  );
});

test("operation cannot acknowledge its writer while a recorded PID is live", async (t) => {
  const root = await temporaryRoot(t);
  const processPath = path.join(root, "process.jsonl");
  const journal = new NpmProcessJournal(processPath, IDENTITY);
  const tool = fakeToolIdentity();
  const nonce = "b".repeat(64);
  journal.started({
    pid: process.pid,
    nonce,
    tool,
    arguments: ["dist-tag"],
    npmCommand: [
      tool.node.path,
      tool.npmCli.path,
      `--user-agent=1667-npm-operation-${nonce}`,
      "dist-tag"
    ]
  });
  const calls: string[] = [];
  const lease: NpmTagOperationLease = {
    async acquireWriter() { calls.push("writer"); },
    async verifyWriter() { calls.push("verify"); },
    async acknowledgeWriter() { calls.push("acknowledge"); },
    async complete() { calls.push("complete"); },
    async fail() { calls.push("fail"); }
  };
  const previous = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = "c".repeat(64);
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previous;
  });
  await assert.rejects(runNpmTagOperation({
    command: "promote",
    version: VERSION,
    evidencePath: path.join(root, "evidence.jsonl"),
    processJournalPath: processPath,
    lease: {
      repository: "1667-ai/1667",
      ...IDENTITY,
      operation: "promotion"
    },
    parameters: {
      operation: "promotion",
      promotion: { destination: "latest", stableAcknowledged: false }
    }
  }, {
    lease,
    access: { async verify() {} },
    processJournal: journal,
    registry: () => new AlreadyPromotedRegistry()
  }), /npm process \d+ \([0-9a-f]{64}\) is active/u);
  assert.deepEqual(calls, ["writer"]);
});

class AlreadyPromotedRegistry implements NpmTagRegistry {
  async settleAbsence(): Promise<void> {}

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    return {
      name,
      version,
      present: true,
      deprecated: null,
      tags: { latest: version, next: version }
    };
  }
  async addTag(): Promise<void> { throw new Error("unexpected write"); }
  async removeTag(): Promise<void> { throw new Error("unexpected write"); }
  async deprecate(): Promise<void> { throw new Error("unexpected write"); }
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-child-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeToolIdentity(): NpmProcessToolIdentity {
  const sha256 = "d".repeat(64);
  return {
    node: { path: "/tool/node", sha256 },
    npmCli: { path: "/tool/npm-cli.js", sha256 },
    runner: { path: "/tool/runner.mjs", sha256 }
  };
}

function largeStarted(
  nonce: string,
  argumentCount: number,
  argumentBytes: number
): {
  readonly pid: number;
  readonly nonce: string;
  readonly tool: NpmProcessToolIdentity;
  readonly arguments: readonly string[];
  readonly npmCommand: readonly string[];
} {
  const tool = fakeToolIdentity();
  const arguments_ = Array.from(
    { length: argumentCount },
    (_, index) => String.fromCharCode(97 + index).repeat(argumentBytes)
  );
  return {
    pid: process.pid,
    nonce,
    tool,
    arguments: arguments_,
    npmCommand: [
      tool.node.path,
      tool.npmCli.path,
      `--user-agent=1667-npm-operation-${nonce}`,
      ...arguments_
    ]
  };
}
