import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  npmQuarantineMessage,
  npmReleaseOperationPackageOrder,
  promoteNpmReleaseTags,
  quarantineNpmReleaseTags,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";
import { runNpmTagOperation, type NpmTagOperationLease } from
  "../scripts/release-npm-operations-cli.js";

const VERSION = "1.2.3";
const OTHER_VERSION = "1.2.2";
const SUPERSEDING_VERSION = "1.2.4";
const PROMOTION = { destination: "latest", stableAcknowledged: false } as const;
const QUARANTINE = { supersedingVersion: SUPERSEDING_VERSION,
  incidentReference: "https://github.com/1667-ai/1667/issues/111" } as const;
const QUARANTINE_MESSAGE = npmQuarantineMessage(QUARANTINE);
const PROMOTION_ORDER = [...PUBLISHED_PLATFORM_PACKAGES, RELEASE_LAUNCHER_PACKAGE];
const QUARANTINE_ORDER = [RELEASE_LAUNCHER_PACKAGE, ...PUBLISHED_PLATFORM_PACKAGES];
test("promotion package order puts every platform before the launcher", () => {
  assert.deepEqual(npmReleaseOperationPackageOrder("promotion"), PROMOTION_ORDER);
});
test("quarantine package order puts the launcher before every platform", () => {
  assert.deepEqual(npmReleaseOperationPackageOrder("quarantine"), QUARANTINE_ORDER);
});
test("operation orchestration binds journal, writer, writes, and terminal", async (t) => {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), "1667-npm-orchestration-")
  ));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, "journal.jsonl");
  const claimSecret = "a".repeat(64);
  const originalClaim = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = claimSecret;
  t.after(() => {
    if (originalClaim === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = originalClaim;
  });
  const calls: string[] = [];
  let writerSecret = "";
  const lastRecord = async (): Promise<string> => {
    const lines = (await readFile(journal, "utf8")).trimEnd().split("\n");
    return (JSON.parse(lines.at(-1)!) as { record: string }).record;
  };
  const lease: NpmTagOperationLease = {
    async acquireWriter(_request, claim, writer) {
      assert.equal(await lastRecord(), "started");
      assert.equal(claim, claimSecret);
      assert.match(writer, /^[0-9a-f]{64}$/u);
      writerSecret = writer; calls.push("writer");
    },
    async verifyWriter(_request, writer) {
      assert.equal(writer, writerSecret);
      assert.equal(await lastRecord(), "event");
      calls.push("verify");
    },
    async acknowledgeWriter(_request, writer, outcome) {
      assert.equal(writer, writerSecret);
      assert.equal(await lastRecord(), "complete");
      calls.push(`acknowledge-${outcome}`);
    },
    async complete(_request, claim) {
      assert.equal(claim, claimSecret);
      calls.push("complete");
    },
    async fail() { throw new Error("unexpected failed lease"); }
  };
  const registry = new FakeTagRegistry(states());
  await runNpmTagOperation({
    command: "promote",
    version: VERSION,
    evidencePath: journal,
    processJournalPath: path.join(root, "processes.jsonl"),
    lease: {
      repository: "1667-ai/1667", runId: "12345", runAttempt: "2",
      operation: "promotion", version: VERSION,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    },
    parameters: { operation: "promotion", promotion: PROMOTION }
  }, {
    lease,
    access: {
      async verify(names) {
        assert.deepEqual(names, PROMOTION_ORDER);
        calls.push("access");
      }
    },
    registry: (authorizeWrite) => {
      registry.authorizeWrite = authorizeWrite;
      return registry;
    },
    assertProcessQuiescent: () => {}
  });
  assert.deepEqual(calls, [
    "writer", ...PROMOTION_ORDER.flatMap(() => ["access", "verify"]),
    "acknowledge-success",
    "complete"
  ]);
});
test("promotion verifies all packages before changing tags", async () => {
  const registry = new FakeTagRegistry(states({
    [PUBLISHED_PLATFORM_PACKAGES[2]!]: {
      deprecated: "withdrawn",
      tags: { latest: OTHER_VERSION, next: VERSION }
    }
  }));
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /deprecated/u
  );
  assert.deepEqual(registry.writes, []);
});
test("promotion refuses an absent exact version before changing tags", async () => {
  const input = states();
  input.get(PUBLISHED_PLATFORM_PACKAGES[2]!)!.present = false;
  input.get(PUBLISHED_PLATFORM_PACKAGES[2]!)!.tags = {};
  const registry = new FakeTagRegistry(input);
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /does not contain/u
  );
  assert.deepEqual(registry.writes, []);
});
test("promotion accepts only acknowledged stable and closed destination tags", async () => {
  await assert.rejects(
    promoteNpmReleaseTags(new FakeTagRegistry(states()), VERSION, {
      destination: "stable",
      stableAcknowledged: false
    }),
    /explicit acknowledgment/u
  );
  const stable = new FakeTagRegistry(states());
  await promoteNpmReleaseTags(stable, VERSION, {
    destination: "stable",
    stableAcknowledged: true
  });
  assert.deepEqual(
    stable.writes,
    PROMOTION_ORDER.map((name) => `add:${name}:stable`)
  );
  await assert.rejects(
    promoteNpmReleaseTags(new FakeTagRegistry(states()), VERSION, {
      destination: "canary" as "latest",
      stableAcknowledged: false
    }),
    /destination is invalid/u
  );
});
test("one promotion write failure stops every later package", async () => {
  const registry = new FakeTagRegistry(states());
  registry.failWrite = `add:${PUBLISHED_PLATFORM_PACKAGES[1]}:latest`;
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /simulated write failure/u
  );
  assert.deepEqual(registry.writes, [
    `add:${PUBLISHED_PLATFORM_PACKAGES[0]}:latest`,
    `add:${PUBLISHED_PLATFORM_PACKAGES[1]}:latest`
  ]);
});
test("promotion records progress before a failing registry write", async () => {
  const registry = new FakeTagRegistry(states());
  registry.failWrite = `add:${PUBLISHED_PLATFORM_PACKAGES[1]}:latest`;
  const events: string[] = [];
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION, (event) => {
      events.push(event.kind);
    }),
    /simulated write failure/u
  );
  assert.deepEqual(events, [
    "before",
    "write-attempt",
    "write-verified",
    "write-attempt"
  ]);
});
test("promotion stops when a package changes before its write", async () => {
  const registry = new FakeTagRegistry(states());
  registry.beforeInspect = (name, count, state) => {
    if (name === PUBLISHED_PLATFORM_PACKAGES[1] && count === 2) {
      state.deprecated = "withdrawn";
    }
  };
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /deprecated/u
  );
  assert.deepEqual(registry.writes, [
    `add:${PUBLISHED_PLATFORM_PACKAGES[0]}:latest`
  ]);
});

test("promotion stops when a package changes after its write", async () => {
  const registry = new FakeTagRegistry(states());
  registry.beforeInspect = (name, count, state) => {
    if (name === PUBLISHED_PLATFORM_PACKAGES[0] && count === 3) {
      state.deprecated = "withdrawn";
    }
  };
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /deprecated/u
  );
  assert.deepEqual(registry.writes, [
    `add:${PUBLISHED_PLATFORM_PACKAGES[0]}:latest`
  ]);
});

test("promotion detects a tag write that did not change registry state", async () => {
  const registry = new FakeTagRegistry(states());
  registry.ignoreWrites = true;
  await assert.rejects(
    promoteNpmReleaseTags(registry, VERSION, PROMOTION),
    /latest tag did not change/u
  );
  assert.deepEqual(registry.writes, [
    `add:${PUBLISHED_PLATFORM_PACKAGES[0]}:latest`
  ]);
});

test("promotion retry skips tags that already name the version", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION));
  const evidence = await promoteNpmReleaseTags(registry, VERSION, PROMOTION);
  assert.deepEqual(registry.writes, []);
  assert.equal(evidence.operation, "promotion");
  assert.deepEqual(evidence.packageOrder, PROMOTION_ORDER);
});

test("quarantine removes every matching tag and preserves other tags", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION, {
    beta: VERSION,
    stable: OTHER_VERSION
  }));
  const evidence = await quarantineNpmReleaseTags(registry, VERSION, QUARANTINE);
  assert.deepEqual(
    registry.writes.slice(0, 3),
    [
      `remove:${RELEASE_LAUNCHER_PACKAGE}:latest`,
      `remove:${RELEASE_LAUNCHER_PACKAGE}:next`,
      `remove:${RELEASE_LAUNCHER_PACKAGE}:beta`
    ]
  );
  const launcher = evidence.after.find(
    (state) => state.name === RELEASE_LAUNCHER_PACKAGE
  );
  assert.deepEqual(launcher?.tags, { stable: OTHER_VERSION });
  assert.equal(launcher?.deprecated, QUARANTINE_MESSAGE);
  assert.deepEqual(
    registry.writes.filter((entry) => entry.startsWith("deprecate:")),
    QUARANTINE_ORDER.map((name) => `deprecate:${name}`)
  );
});

test("quarantine removes install tags before an incidental tag failure", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION, {
    beta: VERSION
  }));
  registry.failWrite = `remove:${RELEASE_LAUNCHER_PACKAGE}:beta`;
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, QUARANTINE),
    /simulated write failure/u
  );
  const launcher = await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION);
  assert.deepEqual(launcher.tags, { beta: VERSION });
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:latest`,
    `remove:${RELEASE_LAUNCHER_PACKAGE}:next`,
    `remove:${RELEASE_LAUNCHER_PACKAGE}:beta`
  ]);
});

test("quarantine refuses a tag that was retargeted between removals", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION));
  registry.beforeInspect = (name, count, state) => {
    if (name === RELEASE_LAUNCHER_PACKAGE && count === 3) {
      state.tags.next = OTHER_VERSION;
    }
  };
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, QUARANTINE),
    /next tag changed before removal/u
  );
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:latest`
  ]);
  assert.equal(
    (await registry.inspect(RELEASE_LAUNCHER_PACKAGE, VERSION)).tags.next,
    OTHER_VERSION
  );
});

test("quarantine verifies all packages before changing registry state", async () => {
  const registry = new FakeTagRegistry(states({
    [PUBLISHED_PLATFORM_PACKAGES[2]!]: {
      deprecated: "different incident",
      tags: { latest: VERSION, next: VERSION }
    }
  }, VERSION));
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, QUARANTINE),
    /different deprecation message/u
  );
  assert.deepEqual(registry.writes, []);
});

test("quarantine makes a canceled partial publication safe", async () => {
  const input = states({}, VERSION);
  const present: readonly string[] = PUBLISHED_PLATFORM_PACKAGES.slice(0, 2);
  for (const name of QUARANTINE_ORDER) {
    if (present.includes(name)) continue;
    const state = input.get(name)!;
    state.present = false;
    state.tags = name === RELEASE_LAUNCHER_PACKAGE
      ? { beta: VERSION }
      : {};
  }
  const registry = new FakeTagRegistry(input);
  const evidence = await quarantineNpmReleaseTags(
    registry,
    VERSION,
    QUARANTINE
  );
  assert.deepEqual(
    registry.trace.slice(0, QUARANTINE_ORDER.length),
    QUARANTINE_ORDER.map((name) => `inspect:${name}`)
  );
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:beta`,
    ...present.flatMap((name) => [
      `remove:${name}:latest`,
      `remove:${name}:next`
    ]),
    ...present.map((name) => `deprecate:${name}`)
  ]);
  assert.equal(evidence.before.length, QUARANTINE_ORDER.length);
  assert.deepEqual(
    evidence.after.filter((state) => !state.present).map((state) => state.name),
    QUARANTINE_ORDER.filter((name) => !present.includes(name))
  );
  for (const state of evidence.after.filter((entry) => entry.present)) {
    assert.equal(state.deprecated, QUARANTINE_MESSAGE);
    assert.equal(Object.values(state.tags).includes(VERSION), false);
  }
});

test("quarantine requires an incident and a different superseding version", async () => {
  await assert.rejects(
    quarantineNpmReleaseTags(new FakeTagRegistry(states()), VERSION, {
      incidentReference: "https://example.com/incident/1",
      supersedingVersion: SUPERSEDING_VERSION
    }),
    /incident reference is invalid/u
  );
  await assert.rejects(
    quarantineNpmReleaseTags(new FakeTagRegistry(states()), VERSION, {
      ...QUARANTINE,
      supersedingVersion: VERSION
    }),
    /superseding version is invalid/u
  );
});

test("one quarantine write failure stops every later package", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION));
  registry.failWrite = `remove:${RELEASE_LAUNCHER_PACKAGE}:next`;
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, QUARANTINE),
    /simulated write failure/u
  );
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:latest`,
    `remove:${RELEASE_LAUNCHER_PACKAGE}:next`
  ]);
});

test("quarantine detects a tag removal that did not change registry state", async () => {
  const registry = new FakeTagRegistry(states({}, VERSION));
  registry.ignoreWrites = true;
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, QUARANTINE),
    /still names/u
  );
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:latest`
  ]);
});

test("quarantine retry skips complete tag and deprecation changes", async () => {
  const input = states();
  for (const state of input.values()) {
    state.tags = { stable: OTHER_VERSION };
    state.deprecated = QUARANTINE_MESSAGE;
  }
  const registry = new FakeTagRegistry(input);
  const evidence = await quarantineNpmReleaseTags(registry, VERSION, QUARANTINE);
  assert.deepEqual(registry.writes, []);
  assert.equal(evidence.operation, "quarantine");
});

class FakeTagRegistry implements NpmTagRegistry {
  readonly #states: Map<string, MutableState>;
  readonly #inspectCounts = new Map<string, number>();
  readonly writes: string[] = [];
  readonly trace: string[] = [];
  beforeInspect:
    | ((name: string, count: number, state: MutableState) => void)
    | null = null;
  failWrite: string | null = null;
  ignoreWrites = false;
  authorizeWrite: () => Promise<void> = async () => {};

  constructor(input: Map<string, MutableState>) {
    this.#states = input;
  }

  async settleAbsence(): Promise<void> {}

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    this.trace.push(`inspect:${name}`);
    const state = this.#state(name);
    const count = (this.#inspectCounts.get(name) ?? 0) + 1;
    this.#inspectCounts.set(name, count);
    this.beforeInspect?.(name, count, state);
    return Object.freeze({
      name,
      version,
      present: state.present,
      deprecated: state.deprecated,
      tags: Object.freeze({ ...state.tags })
    });
  }

  async addTag(name: string, version: string, tag: string): Promise<void> {
    await this.authorizeWrite();
    const write = `add:${name}:${tag}`;
    this.#write(write);
    const state = this.#state(name);
    if (!state.present) throw new Error(`cannot add a tag to absent ${name}`);
    if (!this.ignoreWrites) state.tags[tag] = version;
  }

  async removeTag(name: string, _version: string, tag: string): Promise<void> {
    await this.authorizeWrite();
    const write = `remove:${name}:${tag}`;
    this.#write(write);
    const state = this.#state(name);
    if (!this.ignoreWrites) delete state.tags[tag];
  }

  async deprecate(name: string, _version: string, message: string): Promise<void> {
    await this.authorizeWrite();
    const write = `deprecate:${name}`;
    this.#write(write);
    const state = this.#state(name);
    if (!state.present) throw new Error(`cannot deprecate absent ${name}`);
    if (!this.ignoreWrites) state.deprecated = message;
  }

  #write(write: string): void {
    this.trace.push(`write:${write}`);
    this.writes.push(write);
    if (this.failWrite === write) throw new Error("simulated write failure");
  }

  #state(name: string): MutableState {
    const state = this.#states.get(name);
    if (state === undefined) throw new Error(`missing fake state for ${name}`);
    return state;
  }
}

interface MutableState {
  present: boolean;
  deprecated: string | null;
  tags: Record<string, string>;
}

function states(
  overrides: Readonly<Record<string, Partial<MutableState>>> = {},
  latest = OTHER_VERSION,
  extraTags: Readonly<Record<string, string>> = {}
): Map<string, MutableState> {
  return new Map(PROMOTION_ORDER.map((name) => {
    const override = overrides[name];
    return [name, {
      present: override?.present ?? true,
      deprecated: override?.deprecated ?? null,
      tags: {
        latest,
        next: VERSION,
        ...extraTags,
        ...override?.tags
      }
    }];
  }));
}
