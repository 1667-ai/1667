import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  npmReleaseOperationPackageOrder,
  quarantineNpmReleaseTags,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const OTHER_VERSION = "1.2.4";
const REQUEST = {
  incidentReference: "https://github.com/1667-ai/1667/issues/111",
  supersedingVersion: OTHER_VERSION
} as const;

test("quarantine settles absent versions before it permits a write", async () => {
  const registry = new AppearingRegistry();
  const evidence = await quarantineNpmReleaseTags(registry, VERSION, REQUEST);

  const order = npmReleaseOperationPackageOrder("quarantine");
  assert.deepEqual(
    registry.trace.slice(0, order.length + 1),
    [...order.map((name) => `inspect:${name}`), "settle"]
  );
  assert.deepEqual(registry.writes, [
    `remove:${RELEASE_LAUNCHER_PACKAGE}:beta`,
    `deprecate:${RELEASE_LAUNCHER_PACKAGE}`
  ]);
  assert.equal(evidence.before[0]?.present, true);
});

test("quarantine refuses a new absence without a settlement interval", async () => {
  const registry = new DisappearingRegistry();
  await assert.rejects(
    quarantineNpmReleaseTags(registry, VERSION, REQUEST),
    /absence is not settled/u
  );
  assert.equal(registry.settlements, 0);
  assert.deepEqual(registry.writes, []);
});

class AppearingRegistry implements NpmTagRegistry {
  readonly trace: string[] = [];
  readonly writes: string[] = [];
  #settled = false;
  #launcherTag = true;
  #deprecation: string | null = null;

  async settleAbsence(): Promise<void> {
    this.trace.push("settle");
    this.#settled = true;
  }

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    this.trace.push(`inspect:${name}`);
    const launcher = name === RELEASE_LAUNCHER_PACKAGE;
    return state(name, version, {
      present: launcher && this.#settled,
      deprecated: launcher ? this.#deprecation : null,
      tags: launcher && this.#launcherTag ? { beta: version } : {}
    });
  }

  async addTag(): Promise<void> {
    throw new Error("unexpected add");
  }

  async removeTag(name: string, _version: string, tag: string): Promise<void> {
    this.writes.push(`remove:${name}:${tag}`);
    this.#launcherTag = false;
  }

  async deprecate(
    name: string,
    _version: string,
    message: string
  ): Promise<void> {
    this.writes.push(`deprecate:${name}`);
    this.#deprecation = message;
  }
}

class DisappearingRegistry implements NpmTagRegistry {
  readonly writes: string[] = [];
  settlements = 0;
  #inspections = 0;

  async settleAbsence(): Promise<void> {
    this.settlements += 1;
  }

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    this.#inspections += 1;
    const afterPreflight = this.#inspections
      > PUBLISHED_PLATFORM_PACKAGES.length + 1;
    return state(name, version, {
      present: !(afterPreflight && name === RELEASE_LAUNCHER_PACKAGE),
      deprecated: null,
      tags: {}
    });
  }

  async addTag(): Promise<void> {
    throw new Error("unexpected add");
  }

  async removeTag(): Promise<void> {
    this.writes.push("remove");
  }

  async deprecate(): Promise<void> {
    this.writes.push("deprecate");
  }
}

function state(
  name: string,
  version: string,
  value: {
    readonly present: boolean;
    readonly deprecated: string | null;
    readonly tags: Readonly<Record<string, string>>;
  }
): NpmPackageTagState {
  return Object.freeze({ name, version, ...value });
}
