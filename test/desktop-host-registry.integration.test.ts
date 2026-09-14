import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopHostRegistry } from "../host/desktop-port-bridge.js";
import { createWorkerStoryApi } from "../tui/src/worker-api.js";
import { readProjectRunRecord } from "../server/project-run-record.js";

test("concurrent desktop windows share one project worker", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-registry-"));
  const registry = new DesktopHostRegistry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const options = { dataDir: path.join(root, "data"), machineDir: path.join(root, "machine") };
  await mkdir(options.machineDir);
  const [first, second] = await Promise.all([
    registry.openProject("project", options), registry.openProject("project", options)
  ]);
  assert.equal(first.host, second.host);
  assert.equal((await readProjectRunRecord(options.dataDir))?.owner, "desktop");
  await assert.rejects(createWorkerStoryApi(options), (error: unknown) => {
    assert.match(String(error), /already open by the 1667 desktop app/);
    assert.doesNotMatch(String(error), /--url/);
    return true;
  });
  await registry.closeProject("project");
  const reopened = await registry.openProject("project", options);
  assert.notEqual(reopened.host, first.host);
});

test("desktop shutdown waits for a starting worker and releases its lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-desktop-startup-close-"));
  const registry = new DesktopHostRegistry();
  const replacement = new DesktopHostRegistry();
  t.after(async () => {
    await registry.dispose();
    await replacement.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const options = { dataDir: path.join(root, "data"), machineDir: path.join(root, "machine") };
  await mkdir(options.machineDir);
  const opening = registry.openProject("project", options);
  await Promise.all([opening, registry.dispose()]);
  await assert.rejects(registry.openProject("project", options), /registry is closed/);
  const next = await replacement.openProject("project", options);
  assert.ok(next.host);
});
