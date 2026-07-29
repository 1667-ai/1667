import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  readHttpDataDirectoryIdentity
} from "../server/data-directory-id.js";
import {
  DATA_DIRECTORY_ID_ENTRY_NAMES,
  DATA_DIRECTORY_ID_FILE,
  HTTP_DATA_DIRECTORY_CLAIM_KEY_LOCK_FILE,
  HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES
} from "../server/data-directory-layout.js";
import {
  DATA_DIRECTORY_ID_GITIGNORE_BLOCK,
  PROJECT_GITIGNORE_FILE
} from "../server/project-layout.js";
import { startHttpListener } from "../server/http-listener.js";
import { withPrivateFileLock } from "../server/private-file-lock.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

test("data lineage survives moves while each live location gets a claim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const original = path.join(root, "project");
  const moved = path.join(root, "PROJECT");
  const relocated = path.join(root, "moved-project");
  await mkdir(original, { mode: 0o700 });
  await writeFile(
    path.join(original, PROJECT_GITIGNORE_FILE),
    "custom-entry\ndata-id\n!data-id\n"
  );
  const firstIdentity = await readHttpDataDirectoryIdentity(
    original,
    machineDirectory
  );
  assert.equal(
    await readFile(path.join(original, PROJECT_GITIGNORE_FILE), "utf8"),
    `custom-entry\ndata-id\n!data-id\n${
      DATA_DIRECTORY_ID_GITIGNORE_BLOCK
    }`
  );

  await rename(original, moved);
  const movedIdentity = await readHttpDataDirectoryIdentity(
    moved,
    machineDirectory
  );
  await rename(moved, relocated);
  const relocatedIdentity = await readHttpDataDirectoryIdentity(
    relocated,
    machineDirectory
  );
  await cp(relocated, original, { recursive: true });
  const copiedIdentity = await readHttpDataDirectoryIdentity(
    original,
    machineDirectory
  );

  assert.equal(movedIdentity.dataDirectoryId, firstIdentity.dataDirectoryId);
  assert.equal(
    relocatedIdentity.dataDirectoryId,
    firstIdentity.dataDirectoryId
  );
  assert.notEqual(
    movedIdentity.dataDirectoryClaimId,
    firstIdentity.dataDirectoryClaimId
  );
  assert.notEqual(
    relocatedIdentity.dataDirectoryClaimId,
    movedIdentity.dataDirectoryClaimId
  );
  assert.equal(copiedIdentity.dataDirectoryId, firstIdentity.dataDirectoryId);
  assert.notEqual(
    copiedIdentity.dataDirectoryClaimId,
    firstIdentity.dataDirectoryClaimId
  );
  assert.deepEqual(
    await readHttpDataDirectoryIdentity(relocated, machineDirectory),
    relocatedIdentity
  );
});

test("data identity preserves a large non-UTF-8 ignore file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const original = Buffer.alloc(70 * 1_024, 0xff);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  await writeFile(ignoreFile, original);

  await readHttpDataDirectoryIdentity(root, machineDirectory);

  const updated = await readFile(ignoreFile);
  assert.ok(updated.subarray(0, original.byteLength).equals(original));
  assert.equal(
    updated.subarray(original.byteLength).toString("utf8"),
    `\n${DATA_DIRECTORY_ID_GITIGNORE_BLOCK}`
  );
});

test("data identity bounds its sparse ignore-file scan", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  const prefixBytes = 512 * 1024 * 1024;
  const block = Buffer.from(DATA_DIRECTORY_ID_GITIGNORE_BLOCK);
  const writable = await open(ignoreFile, "w");
  try {
    await writable.truncate(prefixBytes);
    await writable.write(block, 0, block.byteLength, prefixBytes);
  } finally {
    await writable.close();
  }

  await readHttpDataDirectoryIdentity(root, machineDirectory);

  assert.equal((await stat(ignoreFile)).size, prefixBytes + block.byteLength);
});

test("restart recognizes a managed ignore block before user rules", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const first = await readHttpDataDirectoryIdentity(root, machineDirectory);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  const userEdited = `${await readFile(ignoreFile, "utf8")}user-entry\n`;
  await writeFile(ignoreFile, userEdited);

  const restarted = await readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  );
  const updated = await readFile(ignoreFile, "utf8");

  assert.deepEqual(restarted, first);
  assert.equal(updated, userEdited);
  assert.equal(
    updated.split("# 1667 durable project lineage\n").length - 1,
    1
  );
});

test("restart reasserts lineage after a conflicting ignore rule", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  await runGit(["init", root]);
  const first = await readHttpDataDirectoryIdentity(root, machineDirectory);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  await writeFile(
    ignoreFile,
    `${await readFile(ignoreFile, "utf8")}[[:lower:]]ata-id\n`
  );

  const restarted = await readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  );
  const updated = await readFile(ignoreFile, "utf8");
  await runGit(["-C", root, "clean", "-Xdf"]);

  assert.deepEqual(restarted, first);
  assert.equal(
    updated.split("# 1667 durable project lineage\n").length - 1,
    2
  );
  assert.ok(updated.endsWith(DATA_DIRECTORY_ID_GITIGNORE_BLOCK));
  await writeFile(ignoreFile, `${updated}[]d]ata-id\n`);

  const bracketRestart = await readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  );
  const bracketUpdated = await readFile(ignoreFile, "utf8");
  assert.deepEqual(
    bracketRestart,
    first
  );
  assert.equal(
    bracketUpdated.split("# 1667 durable project lineage\n").length - 1,
    3
  );
  assert.ok(bracketUpdated.endsWith(DATA_DIRECTORY_ID_GITIGNORE_BLOCK));
  await runGit(["-C", root, "config", "core.ignoreCase", "true"]);
  await writeFile(ignoreFile, `${bracketUpdated}DATA-ID\n`);

  const foldedRestart = await readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  );
  const foldedUpdated = await readFile(ignoreFile, "utf8");
  assert.deepEqual(foldedRestart, first);
  assert.equal(
    foldedUpdated.split("# 1667 durable project lineage\n").length - 1,
    4
  );
  assert.ok(foldedUpdated.endsWith(DATA_DIRECTORY_ID_GITIGNORE_BLOCK));
  await runGit(["-C", root, "clean", "-Xdf"]);
  assert.deepEqual(
    await readHttpDataDirectoryIdentity(root, machineDirectory),
    first
  );
});

test("concurrent ignore replacement preserves the user's file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  const replacement = path.join(root, "replacement.gitignore");
  await writeFile(ignoreFile, Buffer.alloc(4 * 1024 * 1024, 0x61));
  await writeFile(replacement, "concurrent-entry\n");

  const firstAttempt = readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  ).catch((error: unknown) => {
    assert.match(
      String(error),
      /(?:project ignore file (?:changed|is not a regular file)|Reserved data-directory file identity changed)/
    );
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await rename(replacement, ignoreFile);
  await firstAttempt;
  await readHttpDataDirectoryIdentity(root, machineDirectory);

  const updated = await readFile(ignoreFile, "utf8");
  assert.ok(updated.startsWith("concurrent-entry\n"));
  assert.ok(updated.endsWith(DATA_DIRECTORY_ID_GITIGNORE_BLOCK));
});

test("tracked lineage replacement keeps the live directory claim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const first = await readHttpDataDirectoryIdentity(root, machineDirectory);
  const identityFile = path.join(root, DATA_DIRECTORY_ID_FILE);
  const replacement = path.join(root, "data-id.checkout");
  await writeFile(replacement, await readFile(identityFile), { mode: 0o644 });
  await rename(replacement, identityFile);

  assert.deepEqual(
    await readHttpDataDirectoryIdentity(root, machineDirectory),
    first
  );
});

test("data identity retries an in-place lineage rewrite", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const first = await readHttpDataDirectoryIdentity(root, machineDirectory);
  let releaseClaimLock!: () => void;
  const claimLockReleased = new Promise<void>((resolve) => {
    releaseClaimLock = resolve;
  });
  let markClaimLockHeld!: () => void;
  const claimLockHeld = new Promise<void>((resolve) => {
    markClaimLockHeld = resolve;
  });
  const holding = withPrivateFileLock({
    directory: machineDirectory,
    fileName: HTTP_DATA_DIRECTORY_CLAIM_KEY_LOCK_FILE,
    directoryLabel: "1667 test claim key",
    timeoutMs: 5_000,
    contentionMessage: () => "test claim key lock timed out"
  }, async () => {
    markClaimLockHeld();
    await claimLockReleased;
  });
  await claimLockHeld;
  const reading = readHttpDataDirectoryIdentity(root, machineDirectory);
  const replacementId = "f".repeat(64);
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const identityFile = path.join(root, DATA_DIRECTORY_ID_FILE);
    const handle = await open(identityFile, "r+");
    try {
      const before = await handle.stat({ bigint: true });
      await handle.truncate(0);
      await handle.writeFile(`${replacementId}\n`);
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      assert.equal(after.ino, before.ino);
      assert.notEqual(after.ctimeNs, before.ctimeNs);
    } finally {
      await handle.close();
    }
  } finally {
    releaseClaimLock();
  }
  await holding;

  const observed = await reading;
  assert.equal(observed.dataDirectoryId, replacementId);
  assert.notEqual(observed.dataDirectoryClaimId, first.dataDirectoryClaimId);
});

test("data identity accepts a correct read-only ignore file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  const ignoreFile = path.join(root, PROJECT_GITIGNORE_FILE);
  await writeFile(ignoreFile, DATA_DIRECTORY_ID_GITIGNORE_BLOCK);
  await chmod(ignoreFile, 0o400);

  const identity = await readHttpDataDirectoryIdentity(root, machineDirectory);

  assert.match(identity.dataDirectoryId, /^[0-9a-f]{64}$/);
  assert.equal(
    await readFile(ignoreFile, "utf8"),
    DATA_DIRECTORY_ID_GITIGNORE_BLOCK
  );
});

test("ignored Git cleanup preserves durable data lineage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  await runGit(["init", root]);
  const first = await readHttpDataDirectoryIdentity(root, machineDirectory);

  await runGit(["-C", root, "clean", "-Xdf"]);
  const restarted = await readHttpDataDirectoryIdentity(
    root,
    machineDirectory
  );

  assert.deepEqual(restarted, first);
});

linuxTest("HTTP opens a Git clone with normal mode and CRLF lineage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-clone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const clone = path.join(root, "clone");
  await mkdir(source, { mode: 0o700 });
  const machineDirectory = await privateMachineDirectory(t);
  await runGit(["init", source]);
  await runGit(["-C", source, "config", "user.name", "1667 test"]);
  await runGit([
    "-C",
    source,
    "config",
    "user.email",
    "test@1667.invalid"
  ]);
  const original = await readHttpDataDirectoryIdentity(
    source,
    machineDirectory
  );
  await runGit(["-C", source, "add", ".gitignore", DATA_DIRECTORY_ID_FILE]);
  await runGit(["-C", source, "commit", "-m", "track lineage"]);
  await runGit([
    "-c",
    "core.autocrlf=true",
    "clone",
    source,
    clone
  ]);
  assert.match(
    await readFile(path.join(clone, DATA_DIRECTORY_ID_FILE), "utf8"),
    /\r\n$/
  );
  const ignoreBefore = await readFile(
    path.join(clone, PROJECT_GITIGNORE_FILE)
  );

  const listener = await startHttpListener({
    port: 0,
    dataDir: clone,
    authStore: { stateRoot: machineDirectory }
  });
  t.after(() => listener.close());
  const checkedOut = await readHttpDataDirectoryIdentity(
    clone,
    machineDirectory
  );

  assert.equal(checkedOut.dataDirectoryId, original.dataDirectoryId);
  assert.deepEqual(
    await readFile(path.join(clone, PROJECT_GITIGNORE_FILE)),
    ignoreBefore
  );
});

linuxTest("an overlapping machine tier ignores its HTTP claim authority", async (t) => {
  const directory = await privateMachineDirectory(t);
  await runGit(["init", directory]);
  await runGit(["-C", directory, "config", "core.ignoreCase", "true"]);
  const ignoreFile = path.join(directory, PROJECT_GITIGNORE_FILE);
  await readHttpDataDirectoryIdentity(directory, directory);
  const currentIgnore = await readFile(ignoreFile, "utf8");
  await writeFile(
    ignoreFile,
    `${currentIgnore}!HTTP-DATA-DIRECTORY-CLAIM-KEY*\n`
  );

  await readHttpDataDirectoryIdentity(directory, directory);

  const ignored = (await readFile(
    ignoreFile,
    "utf8"
  )).split("\n");
  for (const entry of HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES) {
    assert.equal(ignored.includes(entry), true);
    await runGit(["-C", directory, "check-ignore", "--quiet", entry]);
  }
});

linuxTest("an existing project adds HTTP claim authority ignores", async (t) => {
  const directory = await privateMachineDirectory(t);
  await runGit(["init", directory]);
  await writeFile(
    path.join(directory, PROJECT_GITIGNORE_FILE),
    "# 1667 durable project lineage\n"
      + "!data-id\n"
      + "data-id.1667-publish-v1.tmp\n"
  );

  await readHttpDataDirectoryIdentity(directory, directory);

  const ignored = (await readFile(
    path.join(directory, PROJECT_GITIGNORE_FILE),
    "utf8"
  )).split("\n");
  for (const entry of HTTP_DATA_DIRECTORY_CLAIM_KEY_ENTRY_NAMES) {
    assert.equal(ignored.includes(entry), true);
    await runGit(["-C", directory, "check-ignore", "--quiet", entry]);
  }
});

test("data directory identity rejects a malformed authoritative record", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-data-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machineDirectory = await privateMachineDirectory(t);
  await writeFile(
    path.join(root, DATA_DIRECTORY_ID_FILE),
    "not-an-identifier\n",
    { mode: 0o600 }
  );

  await assert.rejects(
    readHttpDataDirectoryIdentity(root, machineDirectory),
    /data-directory ID is malformed/
  );
});

async function privateMachineDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "1667-http-claim-machine-")
  );
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runGit(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
