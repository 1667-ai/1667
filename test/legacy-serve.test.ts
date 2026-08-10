import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { HttpOperationClient } from "../shared/http-operation-client.js";
import {
  HttpListenerAuthority
} from "../shared/http-listener-authority.js";
import { startHttpListener } from "../server/http-listener.js";
import { startLegacyServe } from "../tui/src/http-commands.js";
import { publishDataDirectoryOwnerMarker } from "../server/data-directory-format.js";
import {
  acquireLegacyDataDirectoryLease
} from "../server/legacy-data-directory.js";
import {
  DATA_DIRECTORY_ID_ENTRY_NAMES,
  DATA_DIRECTORY_OWNER_MARKER
} from "../server/data-directory-layout.js";
import { PROJECT_GITIGNORE_FILE } from "../server/project-layout.js";
import { preflightHttpApi } from "../shared/http-compatibility.js";
import {
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../shared/machine-tier-environment.js";

test("legacy lease refuses absent, empty, and ownership-marked paths", {
  skip: process.platform !== "linux"
}, async (t) => {
  const parent = await privateTemporaryDirectory(t, "1667-legacy-");
  const machineDir = await privateTemporaryDirectory(
    t,
    "1667-legacy-machine-"
  );
  await assert.rejects(
    acquireLegacyDataDirectoryLease(
      path.join(parent, "absent"),
      machineDir
    ),
    /existing nonempty/
  );
  const empty = path.join(parent, "empty");
  await mkdir(empty, { mode: 0o700 });
  await assert.rejects(
    acquireLegacyDataDirectoryLease(empty, machineDir),
    /empty/
  );
  assert.deepEqual(await readdir(empty), []);
  await writeFile(path.join(empty, DATA_DIRECTORY_OWNER_MARKER), "");
  await assert.rejects(
    acquireLegacyDataDirectoryLease(empty, machineDir),
    /reserved ownership/
  );
  assert.deepEqual(await readdir(empty), [DATA_DIRECTORY_OWNER_MARKER]);
  const unrelated = path.join(parent, "unrelated");
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(path.join(unrelated, "notes.txt"), "not 1667 data");
  await assert.rejects(
    acquireLegacyDataDirectoryLease(unrelated, machineDir),
    /recognized v1 data directory/
  );
  assert.deepEqual(await readdir(unrelated), ["notes.txt"]);
});

test("legacy serve refuses a platform without retained-directory authority", {
  skip: process.platform === "linux"
}, async (t) => {
  const dataDir = await legacyDataDirectory(t);
  const stateRoot = path.join(
    await privateTemporaryDirectory(t, "1667-legacy-state-parent-"),
    "must-stay-absent"
  );
  const previous = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = stateRoot;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
    } else {
      process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previous;
    }
  });
  await assert.rejects(
    startLegacyServe(dataDir),
    /requires Linux retained-directory authority/
  );
  await assert.rejects(access(stateRoot), /ENOENT/);
});

test("legacy serve refuses a sealed vault before it opens HTTP state", async (t) => {
  const dataDir = await privateTemporaryDirectory(t, "1667-legacy-sealed-");
  await publishDataDirectoryOwnerMarker(dataDir, 5);
  await assert.rejects(startLegacyServe(dataDir), /cannot open a sealed vault/);
});

test("legacy serve rechecks the sealed-vault fence through its retained authority", {
  skip: process.platform !== "linux"
}, async (t) => {
  const dataDir = await legacyDataDirectory(t);
  let lockedAuthority: string | null = null;

  await assert.rejects(
    startLegacyServe(dataDir, {
      beforeLockedVaultCheck: async (authorityPath) => {
        lockedAuthority = authorityPath;
        await publishDataDirectoryOwnerMarker(authorityPath, 5);
      }
    }),
    /legacy HTTP serve cannot open a sealed vault/
  );

  assert.match(lockedAuthority ?? "", /^\/proc\/self\/fd\/\d+$/);
});

test("legacy serve binds a free port and opens unmarked v1 data", {
  skip: process.platform !== "linux"
}, async (t) => {
  const dataDir = await legacyDataDirectory(t);
  const listener = await startLegacyServe(dataDir);
  t.after(() => listener.close());
  // ADR007 removed the fixed 7373 listener; the OS chooses the port.
  assert.match(listener.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await listLegacyStories(listener), []);
  const firstIdentity = await legacyIdentity(listener);
  await assert.rejects(
    startLegacyServe(dataDir),
    /already open by another 1667 process/
  );
  await assert.rejects(
    startHttpListener({ dataDir }),
    /already open by another 1667 process/
  );
  await listener.close();
  const restarted = await startLegacyServe(dataDir);
  t.after(() => restarted.close());
  assert.deepEqual(await legacyIdentity(restarted), firstIdentity);
  const entries = await readdir(dataDir);
  for (const entry of [
    PROJECT_GITIGNORE_FILE,
    ...DATA_DIRECTORY_ID_ENTRY_NAMES
  ]) {
    assert.equal(entries.includes(entry), false);
  }
});

test("legacy serve refuses machine-tier overlap without modifying data", {
  skip: process.platform !== "linux"
}, async (t) => {
  const dataDir = await legacyDataDirectory(t);
  const previous = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
    } else {
      process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previous;
    }
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  });

  for (const stateRoot of [
    dataDir,
    path.join(dataDir, ".machine")
  ]) {
    process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = stateRoot;
    await assert.rejects(
      startLegacyServe(dataDir),
      /machine tier outside the legacy data directory/
    );
  }
  const alias = `${dataDir}-alias`;
  await symlink(dataDir, alias, "dir");
  t.after(async () => await rm(alias, { force: true }));
  process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = dataDir;
  await assert.rejects(
    startLegacyServe(alias),
    /machine tier outside the legacy data directory/
  );
  process.env[MACHINE_TIER_OVERRIDE_VARIABLE] =
    path.join(alias, ".machine");
  await assert.rejects(
    startLegacyServe(dataDir),
    /machine tier outside the legacy data directory/
  );
  delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  process.env.XDG_STATE_HOME = dataDir;
  await assert.rejects(
    startLegacyServe(dataDir),
    /machine tier outside the legacy data directory/
  );
  const entries = await readdir(dataDir);
  assert.deepEqual(entries, ["stories"]);
});

test("legacy serve keeps Linux storage on its retained directory", {
  skip: process.platform !== "linux"
}, async (t) => {
  const dataDir = await legacyDataDirectory(t);
  const moved = `${dataDir}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const listener = await startLegacyServe(dataDir);
  t.after(() => listener.close());

  await rename(dataDir, moved);
  await mkdir(path.join(dataDir, "stories"), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(
    path.join(moved, "stories", "retained.json"),
    JSON.stringify({
      id: "retained",
      title: "Retained authority",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      parts: []
    })
  );

  const stories = await listLegacyStories(listener);
  assert.equal(
    stories.some(({ title }) => title === "Retained authority"),
    true
  );
});

test("legacy serve proves listener ownership before inspecting data", {
  skip: process.platform !== "linux"
}, async (t) => {
  const blocker = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => {
      const address = blocker.address();
      if (address === null || typeof address === "string") {
        reject(new Error("blocker did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const parent = await privateTemporaryDirectory(t, "1667-legacy-");
  const absent = path.join(parent, "must-stay-absent");
  await assert.rejects(startLegacyServe(absent, { port }), /EADDRINUSE/);
  await assert.rejects(readdir(absent), /ENOENT/);
});

async function legacyDataDirectory(t: TestContext): Promise<string> {
  const directory = await privateTemporaryDirectory(t, "1667-legacy-data-");
  await mkdir(path.join(directory, "stories"), { mode: 0o700 });
  return directory;
}

async function legacyIdentity(
  listener: Awaited<ReturnType<typeof startLegacyServe>>
): Promise<{
  readonly dataDirectoryClaimId: string;
  readonly dataDirectoryId: string;
}> {
  const metadata = await preflightHttpApi(
    `${listener.origin}/api/health`,
    undefined,
    fetch,
    {
      capability: listener.authRecord.capabilities.story,
      serverInstanceId: listener.authRecord.instanceId
    }
  );
  return {
    dataDirectoryClaimId: metadata.dataDirectoryClaimId,
    dataDirectoryId: metadata.dataDirectoryId
  };
}

async function listLegacyStories(
  listener: Awaited<ReturnType<typeof startLegacyServe>>
): Promise<Array<{ readonly title: string }>> {
  const binding = { authRecord: listener.authRecord, fetch };
  const operations = new HttpOperationClient({
    authority: new HttpListenerAuthority({
      root: listener.origin,
      binding
    })
  });
  try {
    const reservation = await operations.reserve({
      method: "GET",
      path: "/api/stories",
      binding
    });
    try {
      const response = await fetch(`${listener.origin}/api/stories`, {
        headers: reservation.headers
      });
      assert.equal(response.status, 200);
      return await response.json() as Array<{ readonly title: string }>;
    } finally {
      await reservation.settle();
    }
  } finally {
    operations.dispose();
  }
}

async function privateTemporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const canonicalDirectory = await realpath(directory);
  await chmod(canonicalDirectory, 0o700);
  t.after(() => rm(canonicalDirectory, { recursive: true, force: true }));
  return canonicalDirectory;
}
