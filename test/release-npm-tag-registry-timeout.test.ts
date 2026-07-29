import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RELEASE_LAUNCHER_PACKAGE } from "../shared/release-targets.js";
import {
  PublicNpmTagRegistry,
  type NpmTagMetadataClient
} from "../scripts/release-npm-tag-registry.js";
import {
  NpmProcessJournal,
  type NpmProcessStarted
} from "../scripts/release-npm-process-journal.js";

const VERSION = "1.2.3";
const OTHER_VERSION = "1.2.2";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MAINTAINERS = [{ name: "1667.ai", email: "npm@1667.ai" }] as const;

test("a process journal cannot be combined with legacy journal coordinates", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "1667-npm-timeout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processIdentity = {
    runId: "12345",
    runAttempt: "2",
    operation: "promotion" as const,
    version: VERSION,
    sourceCommit: COMMIT
  };
  const processJournal = new NpmProcessJournal(
    path.join(root, "processes.jsonl"),
    processIdentity
  );

  assert.throws(() => new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {},
    processJournal,
    processIdentity
  }), /either an npm process journal or its path and identity/u);
});

test("absent exact versions use the default ten-minute settlement interval", async () => {
  const waits: number[] = [];
  const registry = new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {},
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    }
  });

  await registry.settleAbsence();
  assert.deepEqual(waits, [10 * 60_000]);
});

test("a transient exact-version absence does not confirm deprecation", async () => {
  let present = true;
  let now = 0;
  const registry = new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {},
    metadata: {
      async read(name, version) {
        if (version !== null) return present ? { name, version } : null;
        return {
          name,
          maintainers: MAINTAINERS,
          "dist-tags": { next: VERSION }
        };
      }
    },
    runner: {
      async run() {
        present = false;
      }
    },
    settleTimeoutMs: 2,
    pollIntervalMs: 1,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });

  await assert.rejects(
    registry.deprecate(RELEASE_LAUNCHER_PACKAGE, VERSION, "quarantined"),
    /write was not confirmed by npm/u
  );
});

test("tag add rechecks promotion policy before npm starts", async (t) => {
  for (const changed of ["next", "deprecated"] as const) {
    await t.test(changed, async () => {
      let started = false;
      let now = 0;
      const registry = new PublicNpmTagRegistry({
        environment: {},
        authorizeWrite: async () => {},
        metadata: {
          async read(name, version) {
            return version === null
              ? {
                  name,
                  maintainers: MAINTAINERS,
                  "dist-tags": {
                    next: changed === "next" ? OTHER_VERSION : VERSION
                  }
                }
              : {
                  name,
                  version,
                  ...(changed === "deprecated"
                    ? { deprecated: "withdrawn" }
                    : {})
                };
          }
        },
        runner: {
          async run() {
            started = true;
          }
        },
        settleTimeoutMs: 2,
        pollIntervalMs: 1,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        }
      });

      await assert.rejects(
        registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest"),
        changed === "next" ? /next tag changed/u : /is deprecated/u
      );
      assert.equal(started, false);
    });
  }
});

test("the final registry read precedes write authorization", async () => {
  const events: string[] = [];
  let written = false;
  const registry = new PublicNpmTagRegistry({
    environment: {},
    authorizeWrite: async () => {
      events.push("authorize");
    },
    metadata: {
      async read(name, version) {
        events.push(version === null ? "read-package" : "read-version");
        return version === null
          ? {
              name,
              maintainers: MAINTAINERS,
              "dist-tags": {
                latest: written ? VERSION : OTHER_VERSION,
                next: VERSION
              }
            }
          : { name, version };
      }
    },
    runner: {
      async run() {
        events.push("write");
        written = true;
      }
    }
  });

  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.deepEqual(events.slice(0, 4), [
    "read-package", "read-version", "authorize", "write"
  ]);
});

test("a timed-out npm writer can commit before exit and is then reconciled", {
  skip: process.platform === "win32",
  timeout: 3_000
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "1667-npm-timeout-")));
  const npmCli = path.join(root, "npm.cjs");
  const pidFile = path.join(root, "pid");
  const committed = path.join(root, "committed");
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGTERM", () => {',
    "  setTimeout(() => {",
    `    fs.writeFileSync(${JSON.stringify(committed)}, "committed");`,
    "    process.exit(1);",
    "  }, 75);",
    "});",
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);

  let childPid: number | undefined;
  t.after(async () => {
    await reap(childPid, pidFile);
    await rm(root, { recursive: true, force: true });
  });
  const registry = new PublicNpmTagRegistry({
    ...processOptions(root),
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    metadata: new MarkerMetadata(committed),
    writeTimeoutMs: 500,
    terminationGraceMs: 250,
    settleTimeoutMs: 40,
    pollIntervalMs: 5
  });
  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  childPid = Number(await readFile(pidFile, "utf8"));
  assert.equal(await readFile(committed, "utf8"), "committed");
  assertProcessIsGone(childPid);
});

test("a timed-out npm writer that ignores SIGTERM is killed before reconciliation", {
  skip: process.platform === "win32",
  timeout: 3_000
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "1667-npm-timeout-")));
  const npmCli = path.join(root, "npm.cjs");
  const pidFile = path.join(root, "pid");
  const startedAtFile = path.join(root, "started-at");
  const lateWrite = path.join(root, "late-write");
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `fs.writeFileSync(${JSON.stringify(startedAtFile)}, String(Date.now()));`,
    'process.on("SIGTERM", () => {});',
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(lateWrite)}, "late"), 1000);`,
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);

  let childPid: number | undefined;
  t.after(async () => {
    await reap(childPid, pidFile);
    await rm(root, { recursive: true, force: true });
  });
  let now = 0;
  const process = processOptions(root);
  const registry = new PublicNpmTagRegistry({
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    processJournal: new DelayedStartedJournal(
      process.processJournalPath,
      process.processIdentity,
      250
    ),
    metadata: new StaticMetadata(),
    writeTimeoutMs: 100,
    terminationGraceMs: 100,
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
  childPid = Number(await readFile(pidFile, "utf8"));
  const startedAt = Number(await readFile(startedAtFile, "utf8"));
  const lateWriteDeadline = startedAt + 1_100;
  await new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, lateWriteDeadline - Date.now()));
  });
  await assert.rejects(readFile(lateWrite), { code: "ENOENT" });
  assertProcessIsGone(childPid);
});

test("an uncertain committed write settles before the client refuses another write", {
  timeout: 10_000
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "1667-npm-timeout-")));
  const npmCli = path.join(root, "npm.cjs");
  const committed = path.join(root, "committed");
  const count = path.join(root, "count");
  await writeFile(npmCli, [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(count)}, "write\\n");`,
    `fs.writeFileSync(${JSON.stringify(committed)}, "committed");`,
    ""
  ].join("\n"));
  await chmod(npmCli, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));

  let now = 0;
  const processJournal = new TerminalThrowingJournal(
    path.join(root, "processes.jsonl"),
    processOptions(root).processIdentity
  );
  const registry = new PublicNpmTagRegistry({
    environment: npmEnvironment(npmCli),
    authorizeWrite: async () => {},
    processJournal,
    metadata: new DelayedMarkerMetadata(committed, () => now),
    pollIntervalMs: 60_000,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });

  await registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "latest");
  assert.equal(now, 6 * 60_000);
  await assert.rejects(
    registry.addTag(RELEASE_LAUNCHER_PACKAGE, VERSION, "beta"),
    /was not confirmed by npm/u
  );
  assert.equal(await readFile(count, "utf8"), "write\n");
});

class MarkerMetadata implements NpmTagMetadataClient {
  readonly #marker: string;

  constructor(marker: string) {
    this.#marker = marker;
  }

  async read(name: string, version: string | null): Promise<unknown> {
    const committed = await readFile(this.#marker)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    return metadata(name, version, committed ? VERSION : OTHER_VERSION);
  }
}

class DelayedMarkerMetadata implements NpmTagMetadataClient {
  readonly #marker: string;
  readonly #now: () => number;

  constructor(marker: string, now: () => number) {
    this.#marker = marker;
    this.#now = now;
  }

  async read(name: string, version: string | null): Promise<unknown> {
    const committed = await readFile(this.#marker)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    const visible = committed && this.#now() > 5 * 60_000;
    if (version !== null) return { name, version };
    return {
      name,
      maintainers: MAINTAINERS,
      "dist-tags": visible
        ? { latest: VERSION, next: VERSION }
        : { latest: OTHER_VERSION, next: VERSION }
    };
  }
}

class StaticMetadata implements NpmTagMetadataClient {
  async read(name: string, version: string | null): Promise<unknown> {
    return metadata(name, version, OTHER_VERSION);
  }
}

class TerminalThrowingJournal extends NpmProcessJournal {
  override terminal(): void {
    throw new Error("terminal journal fixture failure");
  }
}

class DelayedStartedJournal extends NpmProcessJournal {
  readonly #delayMs: number;

  constructor(
    file: string,
    identity: ConstructorParameters<typeof NpmProcessJournal>[1],
    delayMs: number
  ) {
    super(file, identity);
    this.#delayMs = delayMs;
  }

  override started(record: NpmProcessStarted): void {
    super.started(record);
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      this.#delayMs
    );
  }
}

function metadata(name: string, version: string | null, latest: string): unknown {
  return version === null
    ? { name, maintainers: MAINTAINERS, "dist-tags": { latest, next: VERSION } }
    : { name, version };
}

function processOptions(root: string) {
  return {
    processJournalPath: path.join(root, "processes.jsonl"),
    processIdentity: {
      runId: "12345",
      runAttempt: "2",
      operation: "promotion" as const,
      version: VERSION,
      sourceCommit: COMMIT
    }
  };
}

function npmEnvironment(npmCli: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    npm_node_execpath: process.execPath,
    npm_execpath: npmCli
  };
}

async function reap(pid: number | undefined, file: string): Promise<void> {
  const value = pid ?? Number(await readFile(file, "utf8").catch(() => ""));
  if (!Number.isSafeInteger(value) || value <= 0) return;
  try {
    process.kill(value, "SIGKILL");
  } catch {
    // The operation reaped the expected child.
  }
}

function assertProcessIsGone(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH"
  );
}
