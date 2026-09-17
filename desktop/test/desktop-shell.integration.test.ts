import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopShell, type DesktopDialogPort } from "../shell.js";
import type { RecentProjectsStore } from "../recent-projects.js";
import {
  DesktopHostRegistry,
  type DesktopHostRegistry as DesktopHostRegistryType,
  type DesktopProjectHost
} from "../../host/desktop-port-bridge.js";
import type { WorkerHost } from "../../host/worker-host.js";
import {
  decodeDesktopShellRequest,
  type DesktopRecentProject,
  type DesktopShellEvent
} from "../shell-contract.js";
import {
  DATA_DIRECTORY_OWNER_MARKER,
  LEGACY_DATA_OWNER_MARKER
} from "../../server/data-directory-layout.js";
import { dataDirectoryOwnerMarkerText } from "../../server/data-directory-format.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "../../server/settings-v2-default.js";

test("graphical launcher creates, opens, remembers, and reveals a project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-"));
  const machineDir = path.join(root, "machine");
  const events: DesktopShellEvent[] = [];
  const revealed: string[] = [];
  const recent = new MemoryRecentProjectsStore();
  const registry = new FakeRegistry();
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir,
    recent,
    reveal: (target) => revealed.push(target),
    emit: (event) => events.push(event)
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);
    if (!created.ok || created.result.type !== "project") throw new Error("project create failed");
    assert.equal(created.result.project.root, root);
    assert.equal(created.result.project.open, true);
    assert.equal(registry.opened.length, 1);
    assert.equal(registry.opened[0], created.result.project.directory);

    const listed = await shell.handle({ type: "project.recent" });
    assert.equal(listed.ok, true);
    if (!listed.ok || listed.result.type !== "recent") throw new Error("recent project read failed");
    assert.deepEqual(listed.result.projects.map((project) => project.directory), [
      created.result.project.directory
    ]);

    const reopened = await shell.handle({ type: "project.open", root });
    assert.equal(reopened.ok, true);
    if (!reopened.ok || reopened.result.type !== "project") throw new Error("project open failed");
    assert.equal(reopened.result.project.directory, created.result.project.directory);

    const reveal = await shell.handle({ type: "project.reveal", path: root });
    assert.equal(reveal.ok, true);
    assert.deepEqual(revealed, [root]);
    assert.ok(events.some((event) => event.type === "projectChanged" && event.project?.open));
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed project activation keeps the current Host and project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-current-"));
  const nextRoot = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-failed-"));
  const events: DesktopShellEvent[] = [];
  const registry = new FakeRegistry();
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir: path.join(root, "machine"),
    recent: new MemoryRecentProjectsStore(),
    emit: (event) => events.push(event)
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);
    if (!created.ok || created.result.type !== "project") throw new Error("project create failed");
    registry.failOpen = true;
    const failed = await shell.handle({ type: "project.create", root: nextRoot });
    assert.equal(failed.ok, false);
    await shell.publishCurrentState();
    const current = events.filter((event): event is Extract<DesktopShellEvent, { type: "projectChanged" }> => event.type === "projectChanged").at(-1);
    assert.equal(current?.project?.directory, created.result.project.directory);
    assert.equal(registry.closed.length, 0);
  } finally {
    await shell.dispose();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(nextRoot, { recursive: true, force: true })
    ]);
  }
});

test("unsealing an unlocked vault closes and restores the Host around decryption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-vault-"));
  const machineDir = path.join(root, "machine");
  const registry = new FakeRegistry();
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir,
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);
    const sealed = await shell.handle({ type: "vault.seal", password: "shell-vault-password" });
    assert.equal(sealed.ok, true);
    if (!sealed.ok || sealed.result.type !== "vault") throw new Error("vault seal failed");
    assert.deepEqual(
      { vault: sealed.result.project.vault, open: sealed.result.project.open },
      { vault: "sealed", open: false }
    );

    const opened = await shell.handle({ type: "vault.unlock", password: "shell-vault-password" });
    assert.equal(opened.ok, true);
    if (!opened.ok || opened.result.type !== "vault") throw new Error("vault unlock failed");
    assert.deepEqual(
      { vault: opened.result.project.vault, open: opened.result.project.open },
      { vault: "sealed", open: true }
    );
    assert.equal(opened.result.state, "sealed");

    const wrong = await shell.handle({ type: "vault.unseal", password: "wrong-password" });
    assert.equal(wrong.ok, false);
    assert.equal(shell.currentProject?.vault, "sealed");
    assert.equal(shell.currentProject?.open, true);

    const unsealed = await shell.handle({ type: "vault.unseal", password: "shell-vault-password" });
    assert.equal(unsealed.ok, true);
    if (!unsealed.ok || unsealed.result.type !== "vault") throw new Error("vault unseal failed");
    assert.deepEqual(
      { vault: unsealed.result.project.vault, open: unsealed.result.project.open },
      { vault: "unsealed", open: true }
    );
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a correct unseal succeeds even when a concurrent wrong-password unseal races it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-unseal-race-"));
  const machineDir = path.join(root, "machine");
  const registry = new FakeRegistry();
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir,
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);
    const sealed = await shell.handle({ type: "vault.seal", password: "unseal-race-password" });
    assert.equal(sealed.ok, true);
    const unlocked = await shell.handle({ type: "vault.unlock", password: "unseal-race-password" });
    assert.equal(unlocked.ok, true);

    // Neither call is awaited before the next starts: both requests race the
    // Shell's close/reopen window around unsealVault().
    const wrongPromise = shell.handle({ type: "vault.unseal", password: "wrong-unseal-race-password" });
    const correctPromise = shell.handle({ type: "vault.unseal", password: "unseal-race-password" });
    const [wrong, correct] = await Promise.all([wrongPromise, correctPromise]);

    assert.equal(wrong.ok, false);
    if (wrong.ok) throw new Error("wrong-password unseal unexpectedly succeeded");
    // Before the fix this call could instead observe the other request's
    // close/reopen window and fail with "No project is open."
    assert.notEqual(wrong.error.message, "No project is open.");
    assert.match(wrong.error.message, /authentication failed|incorrect/iu);

    assert.equal(correct.ok, true);
    if (!correct.ok || correct.result.type !== "vault") throw new Error("concurrent unseal failed");
    assert.deepEqual(
      { vault: correct.result.project.vault, open: correct.result.project.open },
      { vault: "unsealed", open: true }
    );
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a locked read waits for an in-flight seal instead of racing the active project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-shell-seal-race-"));
  const machineDir = path.join(root, "machine");
  const registry = new FakeRegistry();
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir,
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);

    // vault.unlock is a locked read/write (it starts with `activeProject()`,
    // like `story.export`'s `errorDirectory`, unlike the harness's fake
    // transport calls); without a lock this observes the seal's null window.
    const sealPromise = shell.handle({ type: "vault.seal", password: "seal-race-password" });
    const readPromise = shell.handle({ type: "vault.unlock", password: "seal-race-password" });
    const [sealResult, readResult] = await Promise.all([sealPromise, readPromise]);

    assert.equal(sealResult.ok, true);
    // Before the fix this read could run while `closeActive()` has cleared
    // the active project and fail with "No project is open."
    if (!readResult.ok) assert.notEqual(readResult.error.message, "No project is open.");
    assert.equal(readResult.ok, true);
    if (!readResult.ok || readResult.result.type !== "vault") throw new Error("locked read failed");
    assert.deepEqual(
      { vault: readResult.result.project.vault, open: readResult.result.project.open },
      { vault: "sealed", open: true }
    );
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("graphical story import uses the raw Host transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-import-"));
  const machineDir = path.join(root, "machine");
  const file = path.join(root, "story.md");
  await writeFile(file, "# Imported\n\nA line.\n", "utf8");
  const calls: { method: string; expected: unknown }[] = [];
  const registry = new FakeRegistry({ calls });
  const shell = new DesktopShell({
    registry: registry.asRegistry(),
    machineDir,
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const created = await shell.handle({ type: "project.create", root });
    assert.equal(created.ok, true);
    const imported = await shell.handle({ type: "story.import", file });
    assert.equal(imported.ok, true);
    if (!imported.ok || imported.result.type !== "storyImport") throw new Error("story import failed");
    assert.equal(imported.result.result.title, "Imported");
    assert.deepEqual(calls, [{ method: "importMarkdown", expected: { kind: "absent" } }]);
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("graphical launcher directs an uninitialized folder to Create project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-open-empty-"));
  const shell = new DesktopShell({
    registry: new FakeRegistry().asRegistry(),
    machineDir: path.join(root, "machine"),
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const result = await shell.handle({ type: "project.open", root });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("uninitialized project unexpectedly opened");
    assert.match(result.error.message, /Choose Create project/);
    assert.doesNotMatch(result.error.message, /Run '1667 init'/);
  } finally {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("directory dialog keeps its purpose labels and rejects unsafe labels", async () => {
  const requested: { readonly title?: string; readonly message?: string }[] = [];
  const dialogs: DesktopDialogPort = {
    open: async () => [],
    save: async () => null,
    directory: async (options) => {
      requested.push(options ?? {});
      return null;
    }
  };
  const shell = new DesktopShell({
    registry: new FakeRegistry().asRegistry(),
    machineDir: "/tmp/1667-desktop-dialog-test-machine",
    recent: new MemoryRecentProjectsStore(),
    dialogs,
    emit: () => undefined
  });

  try {
    const response = await shell.handle({
      type: "dialog.directory",
      title: "Choose source folder",
      message: "Choose the existing 1667 data folder to adopt."
    });
    assert.deepEqual(requested, [{
      title: "Choose source folder",
      message: "Choose the existing 1667 data folder to adopt."
    }]);
    assert.equal(response.ok, true);
    assert.deepEqual(
      decodeDesktopShellRequest({
        type: "dialog.directory",
        title: "Choose destination folder",
        message: "Choose the folder that will own the project."
      }),
      {
        type: "dialog.directory",
        title: "Choose destination folder",
        message: "Choose the folder that will own the project."
      }
    );
    assert.equal(decodeDesktopShellRequest({ type: "dialog.directory", title: 7 }), null);
    assert.equal(decodeDesktopShellRequest({ type: "dialog.directory", message: false }), null);
  } finally {
    await shell.dispose();
  }
});

test("graphical launcher adopts the legacy project fixture", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "1667-desktop-adopt-source-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "1667-desktop-adopt-project-"));
  const machineDir = await mkdtemp(path.join(tmpdir(), "1667-desktop-adopt-machine-"));
  await writeFile(
    path.join(source, LEGACY_DATA_OWNER_MARKER),
    dataDirectoryOwnerMarkerText(3),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(source, "settings.v2.state.json"),
    INITIAL_SETTINGS_STATE_V2_TEXT,
    { mode: 0o600 }
  );
  await mkdir(path.join(source, "stories"));
  await writeFile(path.join(source, "stories", "legacy.json"), "{}\n", { mode: 0o600 });
  const registry = new DesktopHostRegistry();
  const shell = new DesktopShell({
    registry,
    machineDir,
    recent: new MemoryRecentProjectsStore(),
    emit: () => undefined
  });

  try {
    const result = await shell.handle({
      type: "project.adopt",
      source,
      projectRoot
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.result.type !== "project") throw new Error("legacy adoption failed");
    assert.equal(result.result.project.open, true);
    assert.equal((await readdir(source)).includes("stories"), false);
    assert.equal(
      await readFile(
        path.join(result.result.project.directory, DATA_DIRECTORY_OWNER_MARKER),
        "utf8"
      ),
      dataDirectoryOwnerMarkerText(4)
    );
  } finally {
    await shell.dispose();
    await registry.dispose();
    await Promise.all([
      rm(source, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
      rm(machineDir, { recursive: true, force: true })
    ]);
  }
});

class MemoryRecentProjectsStore implements RecentProjectsStore {
  private projects: DesktopRecentProject[] = [];

  list(): Promise<readonly DesktopRecentProject[]> {
    return Promise.resolve(this.projects);
  }

  remember(project: DesktopRecentProject): Promise<readonly DesktopRecentProject[]> {
    this.projects = [project, ...this.projects.filter((entry) => entry.directory !== project.directory)];
    return Promise.resolve(this.projects);
  }

  remove(directory: string): Promise<readonly DesktopRecentProject[]> {
    this.projects = this.projects.filter((entry) => entry.directory !== directory);
    return Promise.resolve(this.projects);
  }
}

class FakeRegistry {
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  failOpen = false;
  private readonly entries = new Map<string, DesktopProjectHost>();

  constructor(private readonly options: { readonly calls?: { method: string; expected: unknown }[] } = {}) {}

  asRegistry(): DesktopHostRegistryType {
    return this as unknown as DesktopHostRegistryType;
  }

  async openProject(id: string): Promise<DesktopProjectHost> {
    if (this.failOpen) throw new Error("simulated Host open failure");
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    this.opened.push(id);
    const host = fakeHost(this.options.calls);
    const entry = { id, host, bridges: new Set() } as DesktopProjectHost;
    this.entries.set(id, entry);
    return entry;
  }

  async closeProject(id: string): Promise<void> {
    this.closed.push(id);
    this.entries.delete(id);
  }
}

function fakeHost(calls: { method: string; expected: unknown }[] | undefined): WorkerHost {
  const transport = {
    call: async (method: string, _input: unknown, options: { expectedAggregateVersion?: unknown } = {}) => {
      if (method === "importMarkdown") {
        calls?.push({ method, expected: options.expectedAggregateVersion });
        return {
          id: "st_imported",
          title: "Imported",
          nodes: [],
          facts: []
        };
      }
      throw new Error(`Unexpected fake worker method: ${method}`);
    }
  };
  return {
    transport: transport as never,
    recovery: Promise.resolve([]),
    recoveryWarnings: [],
    failure: new Promise<Error>(() => undefined),
    dispose: async () => undefined
  };
}
