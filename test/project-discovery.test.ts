import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  PROVIDER_SECRETS_FILE,
  PROJECT_RUN_RECORD_FILE
} from "../server/data-directory-layout.js";
import {
  createProjectTier,
  findProjectRoot,
  initializeProject,
  resolveProject
} from "../server/project-discovery.js";
import {
  PROJECT_DIRECTORY_NAME,
  PROJECT_GITIGNORE_FILE,
  projectDirectory
} from "../server/project-layout.js";

test("discovery walks up from a nested directory, like git", async (t) => {
  const root = await temporaryDirectory(t, "1667-project-root-");
  const nested = path.join(root, "chapters", "three");
  await mkdir(nested, { recursive: true });
  await initializeProject(root);

  assert.equal(await findProjectRoot(nested), root);
  assert.equal(await findProjectRoot(root), root);
});

test("discovery reports no project rather than inventing one", async (t) => {
  const root = await temporaryDirectory(t, "1667-project-none-");

  assert.equal(await findProjectRoot(root), null);
  const outcome = await resolveProject({ cwd: root });
  assert.deepEqual(outcome, { kind: "absent", cwd: root });
  assert.equal(await findProjectRoot(root), null);
});

test("initialization is idempotent and ignores what it must not commit", async (t) => {
  const root = await temporaryDirectory(t, "1667-project-init-");

  const first = await initializeProject(root);
  assert.equal(first.root, root);
  assert.equal(first.directory, await realpath(projectDirectory(root)));
  assert.equal(first.source, "explicit");

  const ignored = await readFile(
    path.join(first.directory, PROJECT_GITIGNORE_FILE),
    "utf8"
  );
  for (const name of [PROVIDER_SECRETS_FILE, PROJECT_RUN_RECORD_FILE]) {
    assert.equal(ignored.split("\n").includes(name), true, `expected ${name}`);
  }

  const second = await initializeProject(root);
  assert.deepEqual(second, first);
  assert.equal(
    await readFile(path.join(second.directory, PROJECT_GITIGNORE_FILE), "utf8"),
    ignored
  );
});

test("a project reached through a symlink resolves to its real path", async (t) => {
  const parent = await temporaryDirectory(t, "1667-project-link-");
  const real = path.join(parent, "real-book");
  const link = path.join(parent, "linked-book");
  await mkdir(real);
  await initializeProject(real);
  await symlink(real, link);

  const outcome = await resolveProject({ cwd: link });
  if (outcome.kind !== "project") throw new Error("expected a discovered project");
  assert.equal(outcome.project.source, "discovered");
  assert.equal(outcome.project.directory, await realpath(projectDirectory(real)));
});

test("an explicit project root names its tier, absent or not", async (t) => {
  const cwd = await temporaryDirectory(t, "1667-project-explicit-");

  const outcome = await resolveProject({ cwd, data: "book" });
  if (outcome.kind !== "project") throw new Error("expected an explicit project");
  assert.equal(outcome.project.source, "explicit");
  assert.equal(outcome.project.root, path.join(cwd, "book"));
  assert.equal(
    outcome.project.directory,
    path.join(cwd, "book", PROJECT_DIRECTORY_NAME)
  );
});

test("--global opens the machine tier's own project", async (t) => {
  const machineRoot = path.join(
    await temporaryDirectory(t, "1667-project-global-"),
    "state"
  );
  const cwd = await temporaryDirectory(t, "1667-project-global-cwd-");

  const outcome = await resolveProject({ cwd, global: true, machineRoot });
  if (outcome.kind !== "project") throw new Error("expected the global project");
  assert.equal(outcome.project.source, "global");
  assert.equal(outcome.project.root, await realpath(machineRoot));
  // Resolution prepares the machine tier but not the project inside it.
  assert.equal(outcome.project.exists, false);
  assert.equal(
    outcome.project.directory,
    path.join(await realpath(machineRoot), "global")
  );
  // The global project is inside the machine tier, not a .1667 beside anything.
  assert.equal(outcome.project.directory.includes(PROJECT_DIRECTORY_NAME), false);

  await assert.rejects(
    resolveProject({ cwd, global: true, data: "book", machineRoot }),
    /select different projects/
  );
});

test("resolution never creates a project, and says whether one exists", async (t) => {
  const cwd = await temporaryDirectory(t, "1667-project-report-");

  const reported = await resolveProject({ cwd, data: "book" });
  if (reported.kind !== "project") throw new Error("expected a reported project");
  assert.equal(reported.project.root, path.join(cwd, "book"));
  assert.equal(
    reported.project.directory,
    path.join(cwd, "book", PROJECT_DIRECTORY_NAME)
  );
  assert.equal(reported.project.exists, false);
  assert.equal(await findProjectRoot(cwd), null);

  await createProjectTier(reported.project.directory);
  const opened = await resolveProject({ cwd, data: "book" });
  if (opened.kind !== "project") throw new Error("expected an existing project");
  assert.equal(opened.project.exists, true);
  assert.equal(await findProjectRoot(path.join(cwd, "book")), path.join(cwd, "book"));
});

test("every creator writes the gitignore that keeps secrets out of a commit", async (t) => {
  const parent = await temporaryDirectory(t, "1667-project-ignore-");
  const machineRoot = path.join(parent, "state");
  const explicit = await initializeProject(path.join(parent, "book"));
  const global = await resolveProject({ cwd: parent, global: true, machineRoot });
  if (global.kind !== "project") throw new Error("expected the global project");
  const globalDirectory = await createProjectTier(global.project.directory);

  for (const directory of [explicit.directory, globalDirectory]) {
    const ignored = (await readFile(
      path.join(directory, PROJECT_GITIGNORE_FILE),
      "utf8"
    )).split("\n");
    for (const name of [PROVIDER_SECRETS_FILE, PROJECT_RUN_RECORD_FILE]) {
      assert.equal(ignored.includes(name), true, `${directory} must ignore ${name}`);
    }
  }
});

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}
