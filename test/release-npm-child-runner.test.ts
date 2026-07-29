import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod, mkdtemp, readFile, realpath, rm, writeFile
} from "node:fs/promises";
import { fstatSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  NpmChildClient, NpmChildStateUncertainError
} from "../scripts/release-npm-child-client.js";
import {
  assertNpmProcessQuiescent,
  inspectNpmProcessQuiescence,
  NpmProcessJournal,
  type NpmProcessJournalIdentity,
  type NpmProcessTerminal
} from "../scripts/release-npm-process-journal.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const IDENTITY: NpmProcessJournalIdentity = Object.freeze({
  runId: "12345",
  runAttempt: "2",
  operation: "promotion",
  version: VERSION,
  sourceCommit: COMMIT
});
test("execve npm starts only after its durable gate and inherits stdin", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const output = path.join(root, "output.json");
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `const journal = fs.readFileSync(${JSON.stringify(path.join(root, "process.jsonl"))}, "utf8");`,
    "const started = journal.trimEnd().split(\"\\n\").map(JSON.parse)"
      + ".findLast((record) => record.record === \"started\");",
    `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
    "  pid: process.pid,",
    "  arguments: process.argv.slice(2),",
    "  startedPid: started?.pid,",
    "  startedNonce: started?.nonce,",
    "  stdin: fs.fstatSync(0),",
    "}));"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 3_000,
    independentTimeoutMs: 3_000
  });
  await client.run(["dist-tag", "add", "@1667-ai/1667@1.2.3", "latest"]);
  const result = JSON.parse(await readFile(output, "utf8")) as {
    pid: number;
    arguments: string[];
    startedPid: number;
    startedNonce: string;
    stdin: { dev: number; ino: number; rdev: number };
  };
  assert.equal(result.pid, result.startedPid);
  assert.ok(result.arguments[0]?.startsWith(
    "--user-agent=1667-npm-operation-"
  ));
  assert.equal(result.arguments[0]?.endsWith(result.startedNonce), true);
  assert.deepEqual(
    [result.stdin.dev, result.stdin.ino, result.stdin.rdev],
    [fstatSync(0).dev, fstatSync(0).ino, fstatSync(0).rdev]
  );
  assertNpmProcessQuiescent(journal.path, IDENTITY);
  const records = await recordsAt(journal.path);
  assert.deepEqual(
    records.map((record) => record.record),
    ["opened", "started", "terminal"]
  );
  assert.equal(records[2]?.outcome, "success");
});
test("independent runner deadline kills npm before a late write", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, "pid");
  const late = path.join(root, "late");
  let fixturePid: number | null = null;
  t.after(() => terminateFixtureProcess(fixturePid));
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGTERM", () => {});',
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), 2500);`,
    "setInterval(() => {}, 1000);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 4_000,
    terminationGraceMs: 100,
    independentTimeoutMs: 1_000
  });
  await assert.rejects(client.run(["dist-tag"]), /deadline.*terminated/u);
  const pid = Number(await readFile(pidFile, "utf8"));
  fixturePid = pid;
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH"
  );
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  await assert.rejects(readFile(late), { code: "ENOENT" });
  assert.equal((await recordsAt(journal.path)).at(-1)?.outcome, "timed-out");
});

test("a terminal callback failure is contained and latches the client", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, "pid");
  const countFile = path.join(root, "count");
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `fs.appendFileSync(${JSON.stringify(countFile)}, "write\\n");`
  ]);
  const journal = new TerminalThrowingJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    independentTimeoutMs: 2_000
  });
  await assert.rejects(
    client.run(["dist-tag"]),
    (error: unknown) => error instanceof NpmChildStateUncertainError
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  assertProcessIsDead(pid);
  await assert.rejects(
    client.run(["dist-tag"]),
    /uncertain; this client refuses another write/u
  );
  assert.equal(await readFile(countFile, "utf8"), "write\n");
});

test("the keeper waits for a slow durable terminal record", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const journal = new DelayedTerminalJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const npmCli = await npmFixture(root, ["process.exitCode = 0;"]);
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    independentTimeoutMs: 3_000
  });

  await client.run(["dist-tag"]);
  assert.equal((await recordsAt(journal.path)).at(-1)?.outcome, "success");
});

test("the keeper rejects an acknowledgment whose terminal record disappeared", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const journal = new ErasingTerminalJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const npmCli = await npmFixture(root, ["process.exitCode = 0;"]);
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    independentTimeoutMs: 3_000
  });

  await assert.rejects(
    client.run(["dist-tag"]),
    (error: unknown) => error instanceof NpmChildStateUncertainError
  );
});

test("worker loss makes the keeper kill npm before it can write", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, "pid");
  const late = path.join(root, "late");
  let fixturePid: number | null = null;
  t.after(() => terminateFixtureProcess(fixturePid));
  const sentinel = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)"
  ], { stdio: "ignore" });
  t.after(() => sentinel.kill("SIGKILL"));
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGTERM", () => {});',
    'process.kill(process.ppid, "SIGKILL");',
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), 750);`,
    "setInterval(() => {}, 1000);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    terminationGraceMs: 50,
    independentTimeoutMs: 2_000
  });
  await assert.rejects(
    client.run(["dist-tag"]),
    (error: unknown) => error instanceof NpmChildStateUncertainError
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  fixturePid = pid;
  assertProcessIsDead(pid);
  assert.doesNotThrow(() => process.kill(sentinel.pid!, 0));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(readFile(late), { code: "ENOENT" });
});

test("keeper loss does not settle before the worker kills npm", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, "pid");
  const late = path.join(root, "late");
  let fixturePid: number | null = null;
  t.after(() => terminateFixtureProcess(fixturePid));
  const npmCli = await npmFixture(root, [
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGTERM", () => {});',
    "const keeperPid = Number(execFileSync("
      + '"/bin/ps", ["-o", "ppid=", "-p", String(process.ppid)], '
      + '{ encoding: "utf8" }).trim());',
    'process.kill(keeperPid, "SIGKILL");',
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), 750);`,
    "setInterval(() => {}, 1000);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    terminationGraceMs: 250,
    independentTimeoutMs: 3_000
  });

  await assert.rejects(
    client.run(["dist-tag"]),
    (error: unknown) => error instanceof NpmChildStateUncertainError
  );
  const pid = Number(await readFile(pidFile, "utf8"));
  fixturePid = pid;
  assertProcessIsDead(pid);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(readFile(late), { code: "ENOENT" });
});

test("quiescence blocks a live runner and succeeds after terminal exit", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const npmCli = await npmFixture(root, [
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const running = childClient(npmCli, journal, {
    writeTimeoutMs: 2_000,
    terminationGraceMs: 50,
    independentTimeoutMs: 4_000
  }).run(["dist-tag"]);
  await waitForStarted(journal.path);
  assert.equal(inspectNpmProcessQuiescence(journal.path, IDENTITY).active.length, 1);
  assert.throws(
    () => assertNpmProcessQuiescent(journal.path, IDENTITY),
    /is active/u
  );
  await assert.rejects(running, /deadline.*terminated/u);
  assertNpmProcessQuiescent(journal.path, IDENTITY);
});

function childClient(
  npmCli: string,
  journal: NpmProcessJournal,
  options: {
    writeTimeoutMs: number;
    terminationGraceMs?: number;
    independentTimeoutMs: number;
  }
): NpmChildClient {
  return new NpmChildClient({
    nodeExecutable: process.execPath,
    npmCli,
    environment: { PATH: process.env.PATH },
    journal,
    writeTimeoutMs: options.writeTimeoutMs,
    terminationGraceMs: options.terminationGraceMs ?? 100,
    independentTimeoutMs: options.independentTimeoutMs
  });
}

async function npmFixture(root: string, lines: readonly string[]): Promise<string> {
  const file = path.join(root, "npm.cjs");
  await writeFile(file, `${lines.join("\n")}\n`);
  await chmod(file, 0o755);
  return file;
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-child-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function recordsAt(file: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => {
    return JSON.parse(line) as Record<string, unknown>;
  });
}

async function waitForStarted(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readFile(file, "utf8")).includes('"record":"started"')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("npm process did not start");
}

class TerminalThrowingJournal extends NpmProcessJournal {
  override terminal(): void {
    throw new Error("terminal journal fixture failure");
  }
}

class DelayedTerminalJournal extends NpmProcessJournal {
  override terminal(record: NpmProcessTerminal): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    super.terminal(record);
  }
}

class ErasingTerminalJournal extends NpmProcessJournal {
  override terminal(record: NpmProcessTerminal): void {
    super.terminal(record);
    const records = readFileSync(this.path, "utf8").trimEnd().split("\n");
    writeFileSync(this.path, `${records.slice(0, -1).join("\n")}\n`);
  }
}

function assertProcessIsDead(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH"
  );
}

function terminateFixtureProcess(pid: number | null): void {
  if (pid === null) return;
  try {
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
