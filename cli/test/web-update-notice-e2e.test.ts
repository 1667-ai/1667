import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { releaseTargetForRuntime } from "../../shared/release-targets.js";
import {
  cleanupWebProcesses,
  scratchProject,
  spawnWeb,
  type ReadyWeb
} from "./web-e2e-fixture.js";

/**
 * The real `1667 web` and its update notice (`docs/web.md`): spawn the CLI,
 * read `/api/status` as an external HTTP client, and hold the preferences to
 * their promise. Nothing here reaches inside the process — the config file,
 * the environment, and the route are the whole surface, matching
 * CLAUDE.md's preference for an end-to-end test.
 *
 * Each run gets its own `XDG_CONFIG_HOME`, so these read and write the same
 * per-user file the TUI does (`~/.config/1667/config.json`) without touching
 * this machine's own. `scratchProject` already isolates `AI_1667_STATE`, so
 * every run starts with an empty update cache.
 *
 * The check waits a second before its first registry request, and every case
 * below reads the route and stops the process inside that second, so none of
 * them depends on a registry being reachable.
 */

afterEach(cleanupWebProcesses);

/** Whether this host has a published release target at all. A held or
 * unknown target has no package to look up, so no check runs and
 * `/api/status` reports a settled answer however the preference reads. */
const CHECK_RUNS_ON_THIS_HOST =
  releaseTargetForRuntime(process.platform, process.arch)?.heldFromPublication === null;

interface UpdateField {
  readonly pending: boolean;
  readonly notice: string | null;
}

async function updateField(web: ReadyWeb): Promise<UpdateField> {
  const response = await fetch(`${web.origin}/api/status`, {
    headers: { authorization: `Bearer ${web.token}` }
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { update?: UpdateField };
  expect(body.update).toBeDefined();
  return body.update!;
}

/** A scratch project whose config file holds `config`, and whose environment
 * lets the check run — `scratchProject` turns it off for every other suite,
 * and these cases are about the check itself. */
async function projectWithConfig(
  config: Readonly<Record<string, unknown>> | null
): Promise<{ readonly dataDir: string; readonly env: NodeJS.ProcessEnv }> {
  const project = await scratchProject();
  const configHome = path.join(path.dirname(project.dataDir), "config");
  if (config !== null) {
    await mkdir(path.join(configHome, "1667"), { recursive: true });
    await writeFile(
      path.join(configHome, "1667", "config.json"),
      JSON.stringify({ schemaVersion: 1, ...config }),
      "utf8"
    );
  }
  const env: NodeJS.ProcessEnv = { ...project.env, XDG_CONFIG_HOME: configHome };
  delete env.AI_1667_NO_UPDATE_CHECK;
  return { dataDir: project.dataDir, env };
}

test("`updates.mode: \"notify\"` runs the check, and `/api/status` says so", async () => {
  const project = await projectWithConfig({ updates: { mode: "notify", channel: "stable" } });
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );

  const update = await updateField(web);
  expect(update.notice).toBeNull();
  expect(update.pending).toBe(CHECK_RUNS_ON_THIS_HOST);

  // Notify only, and the page is the whole surface: the terminal gains no
  // update line of its own.
  expect(web.stdoutText()).not.toContain("available");
  expect(web.stdoutText()).not.toContain("upgrade");
  expect(web.stderrText()).not.toContain("available");
}, 30_000);

test("`updates.mode: \"off\"` silences it: nothing runs and nothing is pending", async () => {
  const project = await projectWithConfig({ updates: { mode: "off", channel: "stable" } });
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );

  expect(await updateField(web)).toEqual({ pending: false, notice: null });
}, 30_000);

test("AI_1667_NO_UPDATE_CHECK=1 silences it whatever the config says", async () => {
  const project = await projectWithConfig({ updates: { mode: "notify", channel: "stable" } });
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    { ...project.env, AI_1667_NO_UPDATE_CHECK: "1" }
  );

  expect(await updateField(web)).toEqual({ pending: false, notice: null });
}, 30_000);

test("the check never blocks startup: an unreadable config still serves the page", async () => {
  const project = await projectWithConfig(null);
  const configHome = path.join(path.dirname(project.dataDir), "config");
  await mkdir(path.join(configHome, "1667"), { recursive: true });
  await writeFile(path.join(configHome, "1667", "config.json"), "{ not json", "utf8");
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );

  // An unreadable config falls back to the defaults, which are notify; what
  // matters here is that the page is served either way.
  const update = await updateField(web);
  expect(update.notice).toBeNull();
  expect(typeof update.pending).toBe("boolean");
}, 30_000);

test("stopping `1667 web` ends the check and releases the project lock", async () => {
  const project = await projectWithConfig({ updates: { mode: "notify", channel: "stable" } });
  const web = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );
  expect((await updateField(web)).pending).toBe(CHECK_RUNS_ON_THIS_HOST);

  web.child.kill("SIGINT");
  const exit = await web.exit;
  expect(exit.code).toBe(0);

  // A second run can take the lock, which an update check left holding a
  // timer would have delayed past this point.
  const second = await spawnWeb(
    ["--data", project.dataDir, "--port", "0", "--no-open"],
    project.env
  );
  expect(second.port).not.toBe(web.port);
}, 60_000);
