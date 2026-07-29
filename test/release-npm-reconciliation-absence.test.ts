import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NpmTagOperationJournal
} from "../scripts/release-npm-operation-journal.js";
import {
  reconcileNpmTagOperation
} from "../scripts/release-npm-operation-reconciliation.js";
import {
  npmQuarantineMessage,
  npmReleaseOperationPackageOrder,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const IDENTITY = {
  runId: "12345",
  runAttempt: "2",
  operation: "quarantine" as const,
  version: VERSION,
  sourceCommit: COMMIT
};
const PARAMETERS = {
  operation: "quarantine" as const,
  quarantine: {
    incidentReference: "https://github.com/1667-ai/1667/issues/111",
    supersedingVersion: "1.2.4"
  }
};

test("quarantine reconciliation settles an absent exact version", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-reconciliation-absence-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const journalPath = path.join(root, "journal.jsonl");
  const order = npmReleaseOperationPackageOrder("quarantine");
  const journal = new NpmTagOperationJournal(
    journalPath,
    { ...IDENTITY, parameters: PARAMETERS },
    order
  );
  journal.close();
  const registry = new TransientAbsenceRegistry();

  const result = await reconcileNpmTagOperation(journalPath, IDENTITY, registry);

  assert.equal(registry.settlements, 1);
  assert.equal(registry.inspections, order.length * 2);
  assert.equal(result.verdict, "retry-required");
  assert.equal(result.observed[0]?.present, true);
});

test("quarantine does not confirm an absence seen only after the wait", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-reconciliation-new-absence-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const journalPath = path.join(root, "journal.jsonl");
  const order = npmReleaseOperationPackageOrder("quarantine");
  const journal = new NpmTagOperationJournal(
    journalPath,
    { ...IDENTITY, parameters: PARAMETERS },
    order
  );
  journal.close();
  const registry = new NewlyAbsentRegistry();

  const result = await reconcileNpmTagOperation(journalPath, IDENTITY, registry);

  assert.equal(registry.settlements, 1);
  assert.equal(result.observed[0]?.present, false);
  assert.equal(result.observed[1]?.present, false);
  assert.equal(result.verdict, "retry-required");
});

class TransientAbsenceRegistry implements NpmTagRegistry {
  inspections = 0;
  settlements = 0;
  #settled = false;

  async settleAbsence(): Promise<void> {
    this.settlements += 1;
    this.#settled = true;
  }

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    this.inspections += 1;
    const present = this.#settled
      && name === npmReleaseOperationPackageOrder("quarantine")[0];
    return Object.freeze({
      name,
      version,
      present,
      deprecated: null,
      tags: Object.freeze({})
    });
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

class NewlyAbsentRegistry implements NpmTagRegistry {
  settlements = 0;
  #settled = false;

  async settleAbsence(): Promise<void> {
    this.settlements += 1;
    this.#settled = true;
  }

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    const index = npmReleaseOperationPackageOrder("quarantine").indexOf(name);
    const present = index !== 0 && (!this.#settled || index !== 1);
    return Object.freeze({
      name,
      version,
      present,
      deprecated: present
        ? npmQuarantineMessage(PARAMETERS.quarantine)
        : null,
      tags: Object.freeze({})
    });
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
