import assert from "node:assert/strict";
import {
  link,
  lstat,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord
} from "../server/mutation-ledger-codec.js";
import { MUTATION_LEDGER_DIRECTORY } from "../server/mutation-ledger-paths.js";
import { privatePublicationScratchPath } from "../server/private-file-publication.js";
import {
  HASH_A,
  ID,
  completedRecord,
  createUserDirectory,
  hasCode,
  hasFsCode,
  preparedRecord,
  receiptDirectory,
  testStore
} from "./mutation-ledger-store-fixture.js";

test("malformed immutable slots are corruption, never idempotency conflicts", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-partial-");
  await store.writeUserRecord(preparedRecord());
  await writeFile(path.join(receiptDirectory(dataDir), "prepared.json"), "{\"schema\":1", "utf8");
  await assert.rejects(store.writeUserRecord(preparedRecord()), hasCode("internal"));
});

test("direct receipt recovery removes unpublished scratch and completes published cleanup", async (t) => {
  await t.test("partial and complete unpublished prepared scratch", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-scratch-drop-");
    const directory = await createUserDirectory(dataDir);
    const preparedFile = path.join(directory, "prepared.json");
    const scratch = privatePublicationScratchPath(preparedFile);

    await writeFile(scratch, "{\"schema\":1", { mode: 0o600 });
    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared: null, completed: null }
    );
    await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));

    await writeFile(scratch, formatMutationLedgerRecord(preparedRecord()), { mode: 0o600 });
    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared: null, completed: null }
    );
    await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
    assert.deepEqual(await readdir(directory), []);
  });

  await t.test("published prepared and completed scratch links", async (subtest) => {
    if (process.platform === "win32") {
      subtest.skip("hard-link crash residue fixture is POSIX-specific");
      return;
    }
    const { dataDir, store } = await testStore(subtest, "1667-ledger-scratch-finish-");
    const directory = await createUserDirectory(dataDir);
    const prepared = preparedRecord();
    const preparedFile = path.join(directory, "prepared.json");
    const preparedScratch = privatePublicationScratchPath(preparedFile);
    await writeFile(
      preparedScratch,
      formatMutationLedgerRecord(prepared),
      { mode: 0o600 }
    );
    await link(preparedScratch, preparedFile);

    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared, completed: null }
    );
    await assert.rejects(lstat(preparedScratch), hasFsCode("ENOENT"));
    assert.equal((await lstat(preparedFile)).nlink, 1);

    const completed = completedRecord(prepared);
    const completedFile = path.join(directory, "completed.json");
    const completedScratch = privatePublicationScratchPath(completedFile);
    await writeFile(completedScratch, "{\"schema\":1", { mode: 0o600 });
    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared, completed: null }
    );
    await assert.rejects(lstat(completedScratch), hasFsCode("ENOENT"));

    await writeFile(
      completedScratch,
      formatMutationLedgerRecord(completed),
      { mode: 0o600 }
    );
    await link(completedScratch, completedFile);

    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared, completed }
    );
    await assert.rejects(lstat(completedScratch), hasFsCode("ENOENT"));
    assert.equal((await lstat(completedFile)).nlink, 1);
  });
});

test("orphan prepared cleanup is direct, proof-bearing, and preserves other evidence", async (t) => {
  await t.test("matching single prepared record", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-cleanup-");
    const prepared = preparedRecord();
    await store.writeUserRecord(prepared);
    assert.equal(
      await store.removeOrphanPreparedUserReceipt(
        "settings",
        ID,
        hashPreparedMutationRecord(prepared)
      ),
      true
    );
    await assert.rejects(lstat(receiptDirectory(dataDir)), hasFsCode("ENOENT"));
    assert.equal(
      await store.removeOrphanPreparedUserReceipt(
        "settings",
        ID,
        hashPreparedMutationRecord(prepared)
      ),
      false
    );
  });

  await t.test("mismatched proof", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-cleanup-hash-");
    await store.writeUserRecord(preparedRecord());
    await assert.rejects(
      store.removeOrphanPreparedUserReceipt("settings", ID, HASH_A),
      hasCode("internal")
    );
    assert.equal((await lstat(receiptDirectory(dataDir))).isDirectory(), true);
  });

  await t.test("completed receipt", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-cleanup-completed-");
    const prepared = preparedRecord();
    await store.writeUserRecord(prepared);
    await store.writeUserRecord(completedRecord(prepared));
    await assert.rejects(
      store.removeOrphanPreparedUserReceipt(
        "settings",
        ID,
        hashPreparedMutationRecord(prepared)
      ),
      hasCode("internal")
    );
    assert.equal((await lstat(path.join(receiptDirectory(dataDir), "completed.json"))).isFile(), true);
  });

  await t.test("additional admitted evidence", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-cleanup-evidence-");
    const prepared = preparedRecord();
    await store.writeUserRecord(prepared);
    await writeFile(path.join(receiptDirectory(dataDir), "started.json"), "retained", { mode: 0o600 });
    await assert.rejects(
      store.removeOrphanPreparedUserReceipt(
        "settings",
        ID,
        hashPreparedMutationRecord(prepared)
      ),
      hasCode("internal")
    );
    assert.equal((await lstat(path.join(receiptDirectory(dataDir), "started.json"))).isFile(), true);
  });
});

test("missing receipt lookup is read-only and repeated direct lookup stays bounded", {
  timeout: 30_000
}, async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-performance-");
  assert.deepEqual(await store.loadUserReceipt("settings", ID), { prepared: null, completed: null });
  assert.deepEqual(await readdir(path.join(dataDir, MUTATION_LEDGER_DIRECTORY)), []);

  const prepared = preparedRecord();
  await store.writeUserRecord(prepared);
  const iterations = 1_000;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const receipt = await store.loadUserReceipt("settings", ID);
    assert.equal(receipt.prepared?.key, ID);
  }
  const elapsed = performance.now() - startedAt;
  t.diagnostic(`${iterations.toLocaleString()} direct receipt lookups in ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 10_000, `direct receipt lookup took ${elapsed.toFixed(1)}ms`);
});

test("settings receipt collector removes only an expired completed receipt", async (t) => {
  const { store } = await testStore(t, "1667-ledger-collector-");
  const prepared = preparedRecord();
  await store.writeUserRecord(prepared);
  assert.equal(
    await store.collectTerminalUserReceipt(
      "settings",
      ID,
      Date.parse("2026-07-01T00:00:00.000Z"),
      new Set()
    ),
    false
  );
  await store.writeUserRecord(completedRecord(prepared));
  assert.equal(
    await store.collectTerminalUserReceipt(
      "settings",
      ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set([ID])
    ),
    false
  );
  assert.equal(
    await store.collectTerminalUserReceipt(
      "settings",
      ID,
      Date.parse("2026-03-31T00:00:00.000Z"),
      new Set()
    ),
    false
  );
  assert.equal(
    await store.collectTerminalUserReceipt(
      "settings",
      ID,
      Date.parse("2026-04-02T00:00:05.000Z"),
      new Set()
    ),
    true
  );
  assert.deepEqual(
    await store.loadUserReceipt("settings", ID),
    { prepared: null, completed: null }
  );
});
