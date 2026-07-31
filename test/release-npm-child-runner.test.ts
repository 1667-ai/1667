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
import { assertProcessIsNotRunning } from "./process-liveness.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const IDENTITY: NpmProcessJournalIdentity = Object.freeze({
  runId: "12345",
  runAttempt: "2",
  operation: "promotion",
  version: VERSION,
  sourceCommit: COMMIT
});
/** Delay between the SIGTERM that npm ignores and the write that must not land. */
const LATE_WRITE_DELAY_MS = 1_000;
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
  timeout: 30_000
}, async (t) => {
  const root = await temporaryRoot(t);
  const pidFile = path.join(root, "pid");
  const late = path.join(root, "late");
  let fixturePid: number | null = null;
  t.after(() => terminateFixtureProcess(fixturePid));
  // The late write starts at SIGTERM, not at npm start, so process start-up
  // cannot move it across the kill. npm keeps the SIGTERM handler empty, so only
  // the SIGKILL that follows the grace can stop the write.
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGTERM", () => {',
    `  setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), ${
      LATE_WRITE_DELAY_MS
    });`,
    "});",
    "setInterval(() => {}, 1000);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  // The independent deadline must outlast three process starts on a loaded
  // machine, and the write deadline must stay above it so that the independent
  // deadline is the one that ends the run.
  const client = childClient(npmCli, journal, {
    writeTimeoutMs: 20_000,
    terminationGraceMs: 100,
    independentTimeoutMs: 5_000
  });
  await assert.rejects(client.run(["dist-tag"]), /deadline.*terminated/u);
  const pid = Number(await readFile(pidFile, "utf8"));
  fixturePid = pid;
  assertProcessIsNotRunning(pid, "npm");
  await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_DELAY_MS * 2));
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
  assertProcessIsNotRunning(pid, "npm");
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
  assertProcessIsNotRunning(pid, "npm");
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
  assertProcessIsNotRunning(pid, "npm");
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(readFile(late), { code: "ENOENT" });
});

test("quiescence blocks a live runner and succeeds after terminal exit", {
  timeout: 15_000
}, async (t) => {
  const root = await temporaryRoot(t);
  // npm runs until the test opens the gate. The test therefore controls when the
  // run ends, so no deadline has to expire and no budget has to be tuned.
  const gate = path.join(root, "gate");
  const npmCli = await npmFixture(root, [
    'const fs = require("node:fs");',
    `setInterval(() => {`,
    `  if (fs.existsSync(${JSON.stringify(gate)})) process.exit(0);`,
    "}, 10);"
  ]);
  const journal = new NpmProcessJournal(
    path.join(root, "process.jsonl"),
    IDENTITY
  );
  const running = childClient(npmCli, journal, {
    writeTimeoutMs: 20_000,
    independentTimeoutMs: 20_000
  }).run(["dist-tag"]);
  await waitForStarted(journal.path, running);
  assert.equal(inspectNpmProcessQuiescence(journal.path, IDENTITY).active.length, 1);
  assert.throws(
    () => assertNpmProcessQuiescent(journal.path, IDENTITY),
    /is active/u
  );

  await writeFile(gate, "open");
  await running;
  assertNpmProcessQuiescent(journal.path, IDENTITY);
  assert.equal((await recordsAt(journal.path)).at(-1)?.outcome, "success");
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

/**
 * Waits for the durable started record. The client writes it when npm reports
 * ready. The wait needs no budget: it races the run, so a run that ends before
 * npm starts fails with the error from the run and not with a timeout.
 */
async function waitForStarted(file: string, running: Promise<void>): Promise<void> {
  let ended = false;
  const ends = running.then(
    () => { ended = true; },
    () => { ended = true; }
  );
  while (!ended) {
    if ((await readFile(file, "utf8")).includes('"record":"started"')) return;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 10)),
      ends
    ]);
  }
  await running;
  throw new Error("the npm run ended before npm started");
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
