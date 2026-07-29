import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  writeNpmOperationReconciliation
} from "../scripts/release-npm-operation-recovery-adapter.js";
import type {
  NpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease-state.js";
import type {
  NpmOperationReconciliation
} from "../scripts/release-npm-operation-reconciliation.js";
import {
  DurableNpmOperationState,
  npmOperationRecoveryPaths,
  npmOperationStateDirectoryName
} from "../scripts/release-npm-operation-workspace.js";
import { canonicalJson } from "../server/canonical-json.js";

const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: "1667-ai/1667",
  runId: "123",
  runAttempt: "1",
  operation: "promotion",
  version: "1.2.3",
  sourceCommit: "a".repeat(40)
});

test("durable state binds secure paths to the exact lease", async (t) => {
  const root = await temporaryRoot(t);
  const state = new DurableNpmOperationState({ XDG_STATE_HOME: root });
  await state.prepareRoot();
  const paths = await state.paths(REQUEST);

  assert.equal(
    path.basename(paths.stateDirectory),
    npmOperationStateDirectoryName(REQUEST)
  );
  assert.equal((await lstat(paths.stateDirectory)).mode & 0o777, 0o700);
  assert.deepEqual(
    await npmOperationRecoveryPaths(paths.stateDirectory, REQUEST),
    paths
  );
  await assert.rejects(
    npmOperationRecoveryPaths(paths.stateDirectory, {
      ...REQUEST,
      runAttempt: "2"
    }),
    /does not match the lease/u
  );
});

test("recovery paths reject a symbolic-link state directory", async (t) => {
  const root = await temporaryRoot(t);
  const target = path.join(root, "target");
  await mkdir(target);
  const linked = path.join(root, npmOperationStateDirectoryName(REQUEST));
  await symlink(target, linked);
  await assert.rejects(
    npmOperationRecoveryPaths(linked, REQUEST),
    /state directory is invalid/u
  );
});

test("reconciliation persistence is create-only and crash-convergent",
  async (t) => {
    const root = await temporaryRoot(t);
    const file = path.join(root, "reconciliation.json");
    const value = reconciliation("complete");
    await writeNpmOperationReconciliation(file, value);
    await writeNpmOperationReconciliation(file, value);

    assert.equal(
      await readFile(file, "utf8"),
      `${canonicalJson(value)}\n`
    );
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await assert.rejects(
      writeNpmOperationReconciliation(
        file,
        reconciliation("safe-to-abandon")
      ),
      /reconciliation record changed/u
    );
  });

test("reconciliation persistence rejects an existing symbolic link", async (t) => {
  const root = await temporaryRoot(t);
  const target = path.join(root, "target.json");
  const file = path.join(root, "reconciliation.json");
  await symlink(target, file);
  await assert.rejects(
    writeNpmOperationReconciliation(file, reconciliation("complete")),
    /reconciliation record changed/u
  );
});

function reconciliation(
  verdict: NpmOperationReconciliation["verdict"]
): NpmOperationReconciliation {
  return {
    schemaVersion: 1,
    registry: "https://registry.npmjs.org/",
    identity: REQUEST,
    parameters: {
      operation: "promotion",
      promotion: { destination: "latest", stableAcknowledged: false }
    },
    packageOrder: [],
    observed: [],
    journal: { records: 1, terminal: "complete", writeAttempts: 0 },
    verdict
  };
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-operation-state-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return realpath(root);
}
