import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  symlink,
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
import {
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  fileBudget,
  wallOnlyTiming,
  startTiming
} from "./performance-budget.js";

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

  await t.test("the same store instance can retry after removal", async (subtest) => {
    const { store } = await testStore(subtest, "1667-ledger-cleanup-retry-");
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
    await store.writeUserRecord(prepared);
    assert.deepEqual(
      await store.loadUserReceipt("settings", ID),
      { prepared, completed: null }
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

test("a swapped ledger ancestor fails closed on later writes", {
  skip: process.platform === "win32"
}, async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-swapped-ancestor-");
  await store.writeUserRecord(preparedRecord());

  // The first write proved the shared hierarchy durable; replacing an
  // ancestor afterwards must still be caught by the per-write inspection.
  const settingsDir = path.join(dataDir, MUTATION_LEDGER_DIRECTORY, "settings");
  const movedDir = path.join(dataDir, "settings-moved");
  await rename(settingsDir, movedDir);
  await symlink(movedDir, settingsDir);

  const second = {
    ...preparedRecord(),
    key: "m1.1767225600000.101112131415161718191a1b1c1d1e1f"
  };
  await assert.rejects(
    store.writeUserRecord(second),
    hasCode("receipt_storage_unavailable")
  );
});

test("a replaced ledger ancestor is proven durable again before later writes", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-replaced-ancestor-");
  await store.writeUserRecord(preparedRecord());

  // Replace a proven ancestor with a different but equally valid private
  // directory. The pathname matches the durable cache while the identity
  // does not, so the store must treat the level as new — re-prove and
  // re-flush it — instead of trusting the stale proof.
  const settingsDir = path.join(dataDir, MUTATION_LEDGER_DIRECTORY, "settings");
  const movedDir = path.join(dataDir, "settings-moved");
  await rename(settingsDir, movedDir);
  await mkdir(settingsDir, { mode: 0o700 });

  const second = {
    ...preparedRecord(),
    key: "m1.1767225600000.101112131415161718191a1b1c1d1e1f" as typeof ID
  };
  await store.writeUserRecord(second);
  assert.deepEqual(
    await store.loadUserReceipt("settings", second.key),
    { prepared: second, completed: null }
  );
  // The original receipt lives in the moved-away tree, not the active one.
  assert.deepEqual(
    await store.loadUserReceipt("settings", ID),
    { prepared: null, completed: null }
  );
});

// These lookups read receipt files, but they do not wait for a disk. The files
// are small, the fixture wrote them a moment ago, and each lookup spends its
// time in system calls and validation. One lookup inspects six directory
// levels, checks each record file for publication residue, and then reads the
// records. The work therefore reports more CPU time than wall-clock time. On
// the arm64 baseline, 1,000 lookups measured about 1,320ms of CPU time against
// about 900ms of wall-clock time.
//
// A wall-clock budget here measures the scheduler, not the product. Beside 16
// busy processes the same 1,000 lookups took 3.6 times the wall-clock time and
// only 1.3 times the CPU time. That is why a full-concurrency run failed this
// test at random while an isolated run passed with ten times the budget spare.
//
// So the first budget measures CPU time. CPU time is what keeps the work for
// each lookup bounded, because more work means more system calls.
//
// The limit comes from measurement. Beside 16 busy processes the worst CPU time
// was 1,708ms. A full-concurrency suite run costs more, because context
// switching adds system time: the worst there was 3,087ms, at a load average of
// 33. This limit keeps about 2.6 times that. Tighten it with new measurements,
// not by guess.
//
// Those same two suite runs measured 14,133ms and 39,621ms of wall-clock time.
// The wall-clock budget this test used before was 10,000ms, so both runs would
// have failed it while the product did the same work.
const LOOKUP_BUDGET = cpuBudget(8_000);

// A CPU budget cannot see a lookup that waits. A lookup that gains a 20ms wait
// keeps its CPU time and stays inside the budget above. Nothing else covers
// this path: receipt lookup runs on the mutation request path, not at startup,
// so no server-start budget reaches it.
//
// So the second budget measures the lower quartile of the lookups. Contention
// delays some lookups, never all of them, so the fast end of the run is the
// part a busy machine cannot inflate. Issue #42 measured its minimum for the
// same reason.
//
// The quartile, rather than the minimum, is what makes the budget hard to
// satisfy. A wait that reached every lookup but one would leave the minimum
// fast. A quarter of 1,000 lookups must stay fast to pass this budget, so a
// wait that reaches three quarters of them fails it.
//
// The quartile holds while the tail does not. Beside 16 busy processes the
// slowest lookups ran between 3.7ms and 27.3ms, and the lower quartile stayed
// between 0.66ms and 1.10ms. Idle runs measured 0.62ms and 0.76ms. A
// full-concurrency suite run is harder again, and measured 1.7ms. This limit
// keeps about six times that.
//
// A total wall-clock budget cannot do this work. Contention alone reached
// 39,621ms across the loop, so a limit that survives contention also admits a
// 20ms wait for every lookup.
const LOOKUP_LATENCY_BUDGET = fileBudget(10);

test("missing receipt lookup is read-only and repeated direct lookup stays bounded", {
  timeout: budgetTimeout([LOOKUP_BUDGET, LOOKUP_LATENCY_BUDGET], 10_000)
}, async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-performance-");
  assert.deepEqual(await store.loadUserReceipt("settings", ID), { prepared: null, completed: null });
  assert.deepEqual(await readdir(path.join(dataDir, MUTATION_LEDGER_DIRECTORY)), []);

  const prepared = preparedRecord();
  await store.writeUserRecord(prepared);
  const iterations = 1_000;
  const read = startTiming();
  const lookupMs: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const receipt = await store.loadUserReceipt("settings", ID);
    lookupMs.push(performance.now() - startedAt);
    assert.equal(receipt.prepared?.key, ID);
  }
  assertWithinBudget(
    t,
    `${iterations.toLocaleString()} direct receipt lookups`,
    LOOKUP_BUDGET,
    read()
  );
  lookupMs.sort((left, right) => left - right);
  assertWithinBudget(
    t,
    "lower-quartile receipt lookup",
    LOOKUP_LATENCY_BUDGET,
    wallOnlyTiming(lookupMs[Math.floor(lookupMs.length / 4)]!)
  );
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
