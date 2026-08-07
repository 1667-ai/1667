import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import {
  privatePublicationScratchPath,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  readOptionalPrivateFiles,
  type PrivateFilePolicy
} from "../server/private-file-publication.js";
import {
  ID,
  hasFsCode,
  preparedRecord,
  receiptDirectory,
  testStore
} from "./mutation-ledger-store-fixture.js";

const POLICY: PrivateFilePolicy = Object.freeze({
  label: "Reserved race-test file",
  maxBytes: 1024 * 1024
});
const posixTest = process.platform === "win32" ? test.skip : test;
const linuxTest = process.platform === "linux" ? test : test.skip;

interface TrackedPublication<T> {
  readonly promise: Promise<T>;
  settled: boolean;
}

function track<T>(promise: Promise<T>): TrackedPublication<T> {
  const tracked: TrackedPublication<T> = { promise, settled: false };
  promise.then(
    () => { tracked.settled = true; },
    () => { tracked.settled = true; }
  );
  return tracked;
}

/** Wait until the live publication window is observable through its
 * deterministic scratch name, or until the publication settles first. */
async function enterPublicationWindow(
  scratch: string,
  publication: TrackedPublication<unknown>
): Promise<boolean> {
  while (!publication.settled) {
    try {
      await lstat(scratch);
      return true;
    } catch {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return false;
}

async function privateDirectory(
  t: Pick<TestContext, "after">,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

posixTest("a reserved reader and a live publication both succeed", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-race-");
  for (let round = 0; round < 16; round += 1) {
    const file = path.join(directory, `reserved-${round}`);
    const bytes = Buffer.from(`round ${round} canonical bytes\n`, "utf8");
    const publication = track(publishPrivateFileNoReplace(file, bytes, POLICY));
    await enterPublicationWindow(privatePublicationScratchPath(file), publication);

    const observed = await readOptionalPrivateFile(file, POLICY);
    await publication.promise;

    assert.ok(observed === null || observed.equals(bytes));
    const settled = await readOptionalPrivateFile(file, POLICY);
    assert.ok(settled !== null && settled.equals(bytes));
    assert.equal((await lstat(file)).nlink, 1);
    await assert.rejects(
      lstat(privatePublicationScratchPath(file)),
      hasFsCode("ENOENT")
    );
  }
});

posixTest("a batch reserved reader and a live publication both succeed", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-batch-race-");
  const sibling = path.join(directory, "committed-sibling");
  const siblingBytes = Buffer.from("committed sibling bytes\n", "utf8");
  await publishPrivateFileNoReplace(sibling, siblingBytes, POLICY);

  for (let round = 0; round < 16; round += 1) {
    const file = path.join(directory, `batch-reserved-${round}`);
    const bytes = Buffer.from(`batch round ${round} bytes\n`, "utf8");
    const publication = track(publishPrivateFileNoReplace(file, bytes, POLICY));
    await enterPublicationWindow(privatePublicationScratchPath(file), publication);

    const observed = await readOptionalPrivateFiles([sibling, file], POLICY);
    await publication.promise;

    const observedSibling = observed[0] ?? null;
    const observedFile = observed[1] ?? null;
    assert.ok(observedSibling !== null && observedSibling.equals(siblingBytes));
    assert.ok(observedFile === null || observedFile.equals(bytes));
    assert.equal((await lstat(file)).nlink, 1);
    assert.equal((await lstat(sibling)).nlink, 1);
  }
});

posixTest("a batch read recovers residue created after directory validation starts", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-batch-residue-");
  const file = path.join(directory, "late-residue");
  const scratch = privatePublicationScratchPath(file);
  const bytes = Buffer.from("late committed bytes\n", "utf8");
  const pause = await pauseNextFileHandleStat(t);

  const reading = readOptionalPrivateFiles([file], POLICY);
  await pause.entered;
  await writeFile(scratch, bytes, { mode: 0o600 });
  await link(scratch, file);
  pause.release();

  const observed = await reading;
  const observedFile = observed[0] ?? null;
  assert.ok(observedFile !== null && observedFile.equals(bytes));
  assert.equal((await lstat(file)).nlink, 1);
  await assert.rejects(lstat(scratch), hasFsCode("ENOENT"));
});

posixTest("a competing publisher fails with EEXIST after the live publication commits", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-compete-");
  for (let round = 0; round < 8; round += 1) {
    const file = path.join(directory, `competed-${round}`);
    const bytes = Buffer.from(`winner ${round}\n`, "utf8");
    const competing = Buffer.from(`loser ${round}\n`, "utf8");
    const publication = track(publishPrivateFileNoReplace(file, bytes, POLICY));
    await enterPublicationWindow(privatePublicationScratchPath(file), publication);

    await assert.rejects(
      publishPrivateFileNoReplace(file, competing, POLICY),
      hasFsCode("EEXIST")
    );
    await publication.promise;

    const settled = await readOptionalPrivateFile(file, POLICY);
    assert.ok(settled !== null && settled.equals(bytes));
    assert.equal((await lstat(file)).nlink, 1);
  }
});

linuxTest("same-turn publishers keep invocation order through a retained directory alias", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-alias-fifo-");
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  t.after(() => handle.close());
  const retainedDirectory = `/proc/self/fd/${handle.fd}`;

  for (let round = 0; round < 16; round += 1) {
    const name = `alias-fifo-${round}`;
    const canonical = path.join(directory, name);
    const retained = path.join(retainedDirectory, name);
    const firstBytes = Buffer.from(`first ${round}\n`, "utf8");
    const secondBytes = Buffer.from(`second ${round}\n`, "utf8");
    const first = publishPrivateFileNoReplace(retained, firstBytes, POLICY);
    const second = publishPrivateFileNoReplace(canonical, secondBytes, POLICY);

    await first;
    await assert.rejects(second, hasFsCode("EEXIST"));
    const settled = await readOptionalPrivateFile(canonical, POLICY);
    assert.ok(settled !== null && settled.equals(firstBytes));
  }
});

posixTest("a concurrent receipt read never breaks a receipt publication", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-live-read-");
  const prepared = preparedRecord();
  const preparedFile = path.join(receiptDirectory(dataDir), "prepared.json");
  const publication = track(store.writeUserRecord(prepared));
  await enterPublicationWindow(
    privatePublicationScratchPath(preparedFile),
    publication
  );

  const observed = await store.loadUserReceipt("settings", ID);
  await publication.promise;

  assert.equal(observed.completed, null);
  if (observed.prepared !== null) {
    assert.deepEqual(observed.prepared, prepared);
  }
  assert.deepEqual(
    await store.loadUserReceipt("settings", ID),
    { prepared, completed: null }
  );
  assert.equal((await lstat(preparedFile)).nlink, 1);
});

posixTest("a killed writer leaves only residue that the next reader recovers", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-killed-");
  const total = 160;
  const engineUrl = new URL(
    "../server/private-file-publication.ts",
    import.meta.url
  ).href;
  const script = `
    import { publishPrivateFileNoReplace } from ${JSON.stringify(engineUrl)};
    const pad = "x".repeat(8192);
    for (let index = 0; index < ${total}; index += 1) {
      await publishPrivateFileNoReplace(
        ${JSON.stringify(directory)} + "/killed-" + index,
        Buffer.from("killed " + index + "\\n" + pad, "utf8"),
        { label: "Killed writer file", maxBytes: 1024 * 1024 }
      );
      process.stdout.write(index + "\\n");
    }
  `;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const reported: number[] = [];
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) reported.push(Number(line));
      if (reported.length >= 3) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
  assert.ok(
    reported.length >= 3,
    `the killed writer committed publications first: ${stderr}`
  );

  let firstAbsent: string | null = null;
  for (let index = 0; index < total; index += 1) {
    const file = path.join(directory, `killed-${index}`);
    const bytes = await readOptionalPrivateFile(file, POLICY);
    if (bytes === null) {
      firstAbsent ??= file;
    } else {
      assert.ok(bytes.toString("utf8").startsWith(`killed ${index}\n`));
      assert.equal((await lstat(file)).nlink, 1);
    }
    await assert.rejects(
      lstat(privatePublicationScratchPath(file)),
      hasFsCode("ENOENT")
    );
    if (reported.includes(index)) {
      assert.notEqual(bytes, null, `reported publication ${index} survived`);
    }
  }
  if (firstAbsent !== null) {
    const replacement = Buffer.from("published after recovery\n", "utf8");
    await publishPrivateFileNoReplace(firstAbsent, replacement, POLICY);
    const settled = await readOptionalPrivateFile(firstAbsent, POLICY);
    assert.ok(settled !== null && settled.equals(replacement));
  }
});

posixTest("a stable extra hard link fails immediately and stays unmodified", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-malicious-");
  const file = path.join(directory, "malicious");
  const alias = path.join(directory, "alias-target");
  const bytes = Buffer.from("linked twice\n", "utf8");
  await writeFile(file, bytes, { mode: 0o600 });
  await link(file, alias);

  const start = performance.now();
  await assert.rejects(
    readOptionalPrivateFile(file, POLICY),
    /unsafe link count/
  );
  await assert.rejects(
    publishPrivateFileNoReplace(file, Buffer.from("other\n", "utf8"), POLICY),
    /unsafe link count/
  );
  const elapsed = performance.now() - start;

  // Immediate refusal: no settle wait, no retry loop, no recovery mutation.
  assert.ok(elapsed < 2_000, `refusal took ${elapsed}ms`);
  assert.equal((await lstat(file)).nlink, 2);
  assert.equal((await lstat(alias)).nlink, 2);
  await assert.rejects(
    lstat(privatePublicationScratchPath(file)),
    hasFsCode("ENOENT")
  );
});

posixTest("a distinct malicious scratch beside a linked final fails immediately", async (t) => {
  const directory = await privateDirectory(t, "1667-publication-malicious-pair-");
  const file = path.join(directory, "malicious-pair");
  const alias = path.join(directory, "alias-pair");
  await writeFile(file, Buffer.from("linked twice\n", "utf8"), { mode: 0o600 });
  await link(file, alias);
  await writeFile(
    privatePublicationScratchPath(file),
    Buffer.from("unrelated\n", "utf8"),
    { mode: 0o600 }
  );

  await assert.rejects(
    readOptionalPrivateFile(file, POLICY),
    /unsafe link count/
  );
  assert.equal((await lstat(file)).nlink, 2);
  assert.equal((await lstat(alias)).nlink, 2);
});

interface StatPause {
  readonly entered: Promise<void>;
  release(): void;
}

async function pauseNextFileHandleStat(
  t: Pick<TestContext, "mock">
): Promise<StatPause> {
  const probe = await open(import.meta.filename, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    stat: FileHandle["stat"];
  };
  await probe.close();
  const originalStat = prototype.stat;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let paused = false;

  t.mock.method(prototype, "stat", async function (this: FileHandle) {
    if (!paused) {
      paused = true;
      enteredResolve();
      await released;
    }
    return await originalStat.call(this);
  });
  return { entered, release: releaseResolve };
}
