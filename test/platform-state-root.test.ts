import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  resolvePrivatePlatformStateRoot,
  resolvePrivatePlatformStateRootPath,
  type WindowsPrivateStateRootAdapter
} from "../server/platform-state-root.js";

test("state-root path resolution does not create its result", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-state-home-");
  const root = await resolvePrivatePlatformStateRootPath({
    platform: "linux",
    environment: {},
    accountHomeDirectory: () => home
  });

  assert.equal(root, path.join(home, ".local", "state", "1667"));
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("Linux state root uses account home and creates a private root", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-state-home-");
  const root = await resolvePrivatePlatformStateRoot({
    platform: "linux",
    environment: {},
    accountHomeDirectory: () => home
  });

  assert.equal(root, path.join(home, ".local", "state", "1667"));
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});

test("Linux accepts only an absolute private XDG state override", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-state-home-");
  const override = await temporaryDirectory(t, "1667-xdg-state-");
  await chmod(override, 0o700);

  const root = await resolvePrivatePlatformStateRoot({
    platform: "linux",
    environment: { XDG_STATE_HOME: override },
    accountHomeDirectory: () => home
  });
  assert.equal(root, path.join(override, "1667"));

  await assert.rejects(
    resolvePrivatePlatformStateRoot({
      platform: "linux",
      environment: { XDG_STATE_HOME: "relative/state" },
      accountHomeDirectory: () => home
    }),
    /absolute canonical/
  );

  const permissive = await temporaryDirectory(t, "1667-xdg-open-");
  await chmod(permissive, 0o755);
  await assert.rejects(
    resolvePrivatePlatformStateRoot({
      platform: "linux",
      environment: { XDG_STATE_HOME: permissive },
      accountHomeDirectory: () => home
    }),
    /permissions are not 0700/
  );
});

test("Linux rejects a symlinked state override", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-state-home-");
  const target = await temporaryDirectory(t, "1667-state-target-");
  const container = await temporaryDirectory(t, "1667-state-link-");
  const alias = path.join(container, "alias");
  await symlink(target, alias, "dir");

  await assert.rejects(
    resolvePrivatePlatformStateRoot({
      platform: "linux",
      environment: { XDG_STATE_HOME: alias },
      accountHomeDirectory: () => home
    }),
    /not a private directory/
  );
});

test("macOS state root is isolated beneath Application Support", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-macos-home-");
  await mkdir(path.join(home, "Library", "Application Support"), {
    recursive: true
  });
  const root = await resolvePrivatePlatformStateRoot({
    platform: "darwin",
    accountHomeDirectory: () => home
  });

  assert.equal(
    root,
    path.join(home, "Library", "Application Support", "1667", "State")
  );
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});

// The test above creates Application Support first, which is why nothing caught
// a resolver that only ever required it. A fixture HOME, a fresh account, and a
// sandboxed environment all lack it.
test("macOS state root creates Application Support when the account lacks it", {
  skip: process.platform === "win32"
}, async (t) => {
  const home = await temporaryDirectory(t, "1667-macos-bare-home-");

  const root = await resolvePrivatePlatformStateRoot({
    platform: "darwin",
    accountHomeDirectory: () => home
  });

  assert.equal(
    root,
    path.join(home, "Library", "Application Support", "1667", "State")
  );
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});

test("Windows state root delegates to its DACL/reparse adapter", async () => {
  let prepared: string | undefined;
  let trustedBase: string | undefined;
  const adapter: WindowsPrivateStateRootAdapter = {
    localAppDataDirectory: async () => "C:\\Users\\Ada\\AppData\\Local",
    preparePrivateStateRoot: async (root, base) => {
      prepared = root;
      trustedBase = base;
      return root;
    }
  };
  assert.equal(
    await resolvePrivatePlatformStateRoot({
      platform: "win32",
      windowsAdapter: adapter
    }),
    "C:\\Users\\Ada\\AppData\\Local\\1667\\State"
  );
  assert.equal(prepared, "C:\\Users\\Ada\\AppData\\Local\\1667\\State");
  assert.equal(trustedBase, "C:\\Users\\Ada\\AppData\\Local");
});

test("simulated Windows fails closed without a native adapter", async () => {
  if (process.platform === "win32") return;
  await assert.rejects(
    resolvePrivatePlatformStateRoot({ platform: "win32" }),
    /DACL\/reparse-safe/
  );
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const canonicalDirectory = await realpath(directory);
  await chmod(canonicalDirectory, 0o700);
  t.after(() => rm(canonicalDirectory, { recursive: true, force: true }));
  return canonicalDirectory;
}
