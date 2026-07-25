import assert from "node:assert/strict";
import {
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
  type WindowsPrivateStateRootAdapter
} from "../server/platform-state-root.js";

test("Linux state root uses account home and creates a private root", async (t) => {
  const home = await temporaryDirectory(t, "1667-state-home-");
  const root = await resolvePrivatePlatformStateRoot({
    platform: "linux",
    environment: {},
    accountHomeDirectory: () => home
  });

  assert.equal(root, path.join(home, ".local", "state", "1667"));
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
});

test("Linux accepts only an absolute private XDG state override", async (t) => {
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

test("Linux rejects a symlinked state override", async (t) => {
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

test("macOS state root is isolated beneath Application Support", async (t) => {
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

test("Windows state root fails closed without DACL/reparse support", async () => {
  await assert.rejects(
    resolvePrivatePlatformStateRoot({ platform: "win32" }),
    /DACL\/reparse-safe/
  );

  let prepared: string | undefined;
  const adapter: WindowsPrivateStateRootAdapter = {
    localAppDataDirectory: async () => "C:\\Users\\Ada\\AppData\\Local",
    preparePrivateStateRoot: async (root) => {
      prepared = root;
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
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const canonicalDirectory = await realpath(directory);
  await chmod(canonicalDirectory, 0o700);
  t.after(() => rm(canonicalDirectory, { recursive: true, force: true }));
  return canonicalDirectory;
}
