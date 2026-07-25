import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  DATA_DIRECTORY_OWNER_MARKER_NEXT,
  DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH,
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE,
  SETTINGS_STATE_V2_NEXT_SCRATCH,
  dataDirectoryOwnerMarkerText,
  readDataDirectoryFormat
} from "../server/data-directory-format.js";
import { ServiceError } from "../server/errors.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "../server/settings-v2-default.js";

const FENCE = ".1667.lock";
const FENCE_TEXT = "1667-lock-aware-legacy-exclusion-v1\n";

test("format 2 initialization recovers partial and complete state-next scratch", async (t) => {
  const expected = Buffer.from(INITIAL_SETTINGS_STATE_V2_TEXT, "utf8");
  for (const [name, bytes] of [
    ["created-empty", expected.subarray(0, 0)],
    ["partial", expected.subarray(0, 173)],
    ["complete", expected]
  ] as const) {
    await t.test(name, async (t) => {
      const dataDir = await makeResidueDirectory(t);
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH),
        bytes,
        { mode: 0o600 }
      );

      await acquireAndRelease(dataDir);

      assert.equal(
        await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8"),
        INITIAL_SETTINGS_STATE_V2_TEXT
      );
      await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE));
      await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH));
      assert.equal(await readDataDirectoryFormat(dataDir), 2);
    });
  }
});

test("format 2 initialization recovers a linked state-next publication pair", async (t) => {
  const dataDir = await makeResidueDirectory(t);
  const scratchPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH);
  const nextPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
  await writeFile(scratchPath, INITIAL_SETTINGS_STATE_V2_TEXT, { mode: 0o600 });
  await link(scratchPath, nextPath);

  await acquireAndRelease(dataDir);

  await assertMissing(scratchPath);
  await assertMissing(nextPath);
  assert.equal(
    await readFile(path.join(dataDir, SETTINGS_STATE_V2_FILE), "utf8"),
    INITIAL_SETTINGS_STATE_V2_TEXT
  );
});

test("format 2 initialization recovers owner-marker scratch and complete next", async (t) => {
  const expected = Buffer.from(dataDirectoryOwnerMarkerText(2), "utf8");
  for (const [name, file, bytes] of [
    ["partial-scratch", DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH, expected.subarray(0, 19)],
    ["complete-scratch", DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH, expected],
    ["complete-next", DATA_DIRECTORY_OWNER_MARKER_NEXT, expected]
  ] as const) {
    await t.test(name, async (t) => {
      const dataDir = await makeResidueDirectory(t);
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_FILE),
        INITIAL_SETTINGS_STATE_V2_TEXT,
        { mode: 0o600 }
      );
      const residuePath = path.join(dataDir, file);
      await writeFile(residuePath, bytes, { mode: 0o600 });
      const residueIdentity = file === DATA_DIRECTORY_OWNER_MARKER_NEXT
        ? await stat(residuePath)
        : null;

      await acquireAndRelease(dataDir);

      assert.equal(
        await readFile(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER), "utf8"),
        dataDirectoryOwnerMarkerText(2)
      );
      if (residueIdentity !== null) {
        assert.equal(
          (await stat(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER))).ino,
          residueIdentity.ino
        );
      }
      await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT));
      await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER_NEXT_SCRATCH));
      assert.equal(await readDataDirectoryFormat(dataDir), 2);
    });
  }
});

test("non-prefix typed scratch is refused before chmod or cleanup", async (t) => {
  const dataDir = await makeResidueDirectory(t);
  const scratchPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH);
  await writeFile(scratchPath, "not-initial-settings", { mode: 0o600 });
  await chmod(dataDir, 0o755);

  await assert.rejects(
    new DataDirectoryLock(dataDir).acquire(),
    /scratch is not an exact prefix/
  );

  assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
  assert.equal(await readFile(scratchPath, "utf8"), "not-initial-settings");
  await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER));
});

test("a live initialization fence takes precedence over invalid typed residue", async (t) => {
  const dataDir = await makeResidueDirectory(t);
  const fencePath = path.join(dataDir, FENCE);
  const scratchPath = path.join(dataDir, SETTINGS_STATE_V2_NEXT_SCRATCH);
  await writeFile(scratchPath, "transient-invalid-settings", { mode: 0o600 });
  await chmod(dataDir, 0o755);
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    "const { open } = await import('node:fs/promises');"
      + "const { lockFile } = await import('./server/os-file-lock.ts');"
      + "const handle = await open(process.env.INIT_FENCE, 'r+');"
      + "await lockFile(handle.fd);"
      + "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, INIT_FENCE: fencePath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForChildReady(child);

  try {
    await assert.rejects(new DataDirectoryLock(dataDir).acquire(), (error: unknown) =>
      error instanceof ServiceError && error.status === 409
        && /already open/.test(error.message)
        && !/initialization residue/.test(error.message));
    assert.equal(await readFile(scratchPath, "utf8"), "transient-invalid-settings");
    assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
    await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER));
    await assertMissing(path.join(dataDir, SETTINGS_STATE_V2_FILE));
  } finally {
    child.kill(process.platform === "win32" ? undefined : "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  await assert.rejects(
    new DataDirectoryLock(dataDir).acquire(),
    /scratch is not an exact prefix/
  );
  assert.equal(await readFile(scratchPath, "utf8"), "transient-invalid-settings");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
  await assertMissing(path.join(dataDir, DATA_DIRECTORY_OWNER_MARKER));
  await assertMissing(path.join(dataDir, ".1667.owner-v1"));
});

async function makeResidueDirectory(
  t: { after(fn: () => Promise<void>): void }
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-init-residue-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, FENCE), FENCE_TEXT);
  return dataDir;
}

async function acquireAndRelease(dataDir: string): Promise<void> {
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.release();
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file));
}

async function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Initialization-fence child exited before ready (${code ?? "signal"})`));
    };
    const onData = (chunk: Buffer | string): void => {
      if (!String(chunk).includes("ready")) return;
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
}
