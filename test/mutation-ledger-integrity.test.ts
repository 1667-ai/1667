import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatMutationLedgerRecord } from "../server/mutation-ledger-codec.js";
import { MUTATION_LEDGER_DIRECTORY } from "../server/mutation-ledger-paths.js";
import type { PreparedUserMutationRecord } from "../server/mutation-ledger-types.js";
import {
  FM1_KEY,
  HASH_A,
  HASH_B,
  ID,
  ancestorLedgerDirectories,
  completedRecord,
  createMigrationDirectory,
  hasCode,
  hasFsCode,
  internalCompletedRecord,
  internalPreparedRecord,
  preparedRecord,
  receiptDirectory,
  testStore
} from "./mutation-ledger-store-fixture.js";

test("mutation ledger store writes immutable private settings receipts by direct path", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-store-");
  const prepared = preparedRecord();
  const completed = completedRecord(prepared);

  await store.writeUserRecord(prepared);
  await store.writeUserRecord(completed);
  await store.writeUserRecord(prepared);
  await store.writeUserRecord(completed);
  const receipt = await store.loadUserReceipt("settings", ID);
  assert.deepEqual(receipt, { prepared, completed });
  assert.ok(Object.isFrozen(receipt));

  const directory = receiptDirectory(dataDir);
  if (process.platform !== "win32") {
    for (const candidate of ancestorLedgerDirectories(dataDir)) {
      assert.equal((await lstat(candidate)).mode & 0o777, 0o700);
    }
    assert.equal((await lstat(path.join(directory, "prepared.json"))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(directory, "completed.json"))).mode & 0o777, 0o600);
  }
  assert.equal((await readFile(path.join(directory, "prepared.json"), "utf8")).endsWith("\n"), false);
});

test("mutation ledger store rejects changed immutable bytes and symlink records", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-unsafe-");
  const prepared = preparedRecord();
  await store.writeUserRecord(prepared);
  await assert.rejects(
    store.writeUserRecord({ ...prepared, fingerprintHash: "c".repeat(64) }),
    hasCode("idempotency_conflict")
  );
  if (process.platform !== "win32") {
    const other = path.join(dataDir, "nonexistent-record");
    await symlink(
      other,
      path.join(receiptDirectory(dataDir), "completed.json")
    );
    await assert.rejects(
      store.loadUserReceipt("settings", ID),
      hasCode("internal")
    );
  }
});

test("completed records require and cryptographically bind their prepared record", async (t) => {
  const first = await testStore(t, "1667-ledger-completion-order-");
  const prepared = preparedRecord();
  const completed = completedRecord(prepared);
  await assert.rejects(first.store.writeUserRecord(completed), hasCode("internal"));
  assert.deepEqual(
    await readdir(path.join(first.dataDir, MUTATION_LEDGER_DIRECTORY)),
    []
  );

  await first.store.writeUserRecord(prepared);
  await assert.rejects(
    first.store.writeUserRecord({ ...completed, preparedRecordHash: HASH_A }),
    hasCode("internal")
  );
  await assert.rejects(lstat(path.join(receiptDirectory(first.dataDir), "completed.json")), hasFsCode("ENOENT"));

  await writeFile(
    path.join(receiptDirectory(first.dataDir), "completed.json"),
    formatMutationLedgerRecord({ ...completed, preparedRecordHash: HASH_A }),
    { mode: 0o600 }
  );
  await assert.rejects(first.store.loadUserReceipt("settings", ID), hasCode("internal"));
});

test("record validation happens before user receipt directories are created", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-preflight-");
  const invalid = { ...preparedRecord(), unknown: true } as unknown as PreparedUserMutationRecord;
  await assert.rejects(store.writeUserRecord(invalid), hasCode("internal"));
  await assert.rejects(
    store.writeUserRecord(internalPreparedRecord() as unknown as PreparedUserMutationRecord),
    hasCode("internal")
  );
  assert.deepEqual(await readdir(path.join(dataDir, MUTATION_LEDGER_DIRECTORY)), []);
});

test("format-migration receipts are strict read-only direct lookups", async (t) => {
  await t.test("absent, prepared, and completed", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-fm1-");
    assert.deepEqual(
      await store.loadFormatMigrationReceipt(FM1_KEY),
      { prepared: null, completed: null }
    );
    assert.deepEqual(await readdir(path.join(dataDir, MUTATION_LEDGER_DIRECTORY)), []);

    const directory = await createMigrationDirectory(dataDir);
    const prepared = internalPreparedRecord();
    await writeFile(
      path.join(directory, "prepared.json"),
      formatMutationLedgerRecord(prepared),
      { mode: 0o600 }
    );
    assert.deepEqual(
      await store.loadFormatMigrationReceipt(FM1_KEY),
      { prepared, completed: null }
    );

    const completed = internalCompletedRecord(prepared);
    await writeFile(
      path.join(directory, "completed.json"),
      formatMutationLedgerRecord(completed),
      { mode: 0o600 }
    );
    const receipt = await store.loadFormatMigrationReceipt(FM1_KEY);
    assert.deepEqual(receipt, { prepared, completed });
    assert.ok(Object.isFrozen(receipt));
  });

  await t.test("completed hash mismatch", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-fm1-hash-");
    const directory = await createMigrationDirectory(dataDir);
    const prepared = internalPreparedRecord();
    await writeFile(
      path.join(directory, "prepared.json"),
      formatMutationLedgerRecord(prepared),
      { mode: 0o600 }
    );
    await writeFile(
      path.join(directory, "completed.json"),
      formatMutationLedgerRecord({
        ...internalCompletedRecord(prepared),
        preparedRecordHash: HASH_B
      }),
      { mode: 0o600 }
    );
    await assert.rejects(store.loadFormatMigrationReceipt(FM1_KEY), hasCode("internal"));
  });
});

test("intermediate symlinks cannot redirect receipt creation", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-parent-link-");
  const outside = await mkdtemp(path.join(tmpdir(), "1667-ledger-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(
    outside,
    path.join(dataDir, MUTATION_LEDGER_DIRECTORY, "settings"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(store.writeUserRecord(preparedRecord()), hasCode("receipt_storage_unavailable"));
  assert.deepEqual(await readdir(outside), []);
});

test("unsafe directory modes, record modes, and hard links fail closed", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode and link-count contract");
    return;
  }

  await t.test("directory mode", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-dir-mode-");
    await store.writeUserRecord(preparedRecord());
    await chmod(receiptDirectory(dataDir), 0o755);
    await assert.rejects(store.loadUserReceipt("settings", ID), hasCode("receipt_storage_unavailable"));
  });

  await t.test("record mode", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-file-mode-");
    await store.writeUserRecord(preparedRecord());
    await chmod(path.join(receiptDirectory(dataDir), "prepared.json"), 0o644);
    await assert.rejects(store.loadUserReceipt("settings", ID), hasCode("internal"));
  });

  await t.test("record hard link", async (subtest) => {
    const { dataDir, store } = await testStore(subtest, "1667-ledger-hard-link-");
    await store.writeUserRecord(preparedRecord());
    await link(
      path.join(receiptDirectory(dataDir), "prepared.json"),
      path.join(dataDir, "receipt-alias")
    );
    await assert.rejects(store.loadUserReceipt("settings", ID), hasCode("internal"));
  });
});
