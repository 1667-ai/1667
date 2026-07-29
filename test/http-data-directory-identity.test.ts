import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_DIRECTORY_ID_FILE } from "../server/data-directory-layout.js";
import { startHttpListener } from "../server/http-listener.js";
import { StoryService } from "../server/story-service.js";

test("HTTP identity uses retained service authority after path replacement", {
  skip: process.platform !== "linux"
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const movedDataDir = path.join(root, "moved-data");
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });

  class ReplacingStoryService extends StoryService {
    override async init(): Promise<void> {
      await super.init();
      await rename(this.dataDir, movedDataDir);
      await mkdir(this.dataDir, { mode: 0o700 });
    }
  }

  const listener = await startHttpListener({
    port: 0,
    authStore: { stateRoot },
    project: { root: dataDir, dataDir },
    serviceFactory: async (_errorReporter, machineDir) =>
      new ReplacingStoryService({
        dataDir,
        machineDir,
        diagnostics: "disabled"
      })
  });
  t.after(() => listener.close());

  assert.equal(
    await exists(path.join(movedDataDir, DATA_DIRECTORY_ID_FILE)),
    true
  );
  assert.equal(
    await exists(path.join(dataDir, DATA_DIRECTORY_ID_FILE)),
    false
  );
});

async function exists(target: string): Promise<boolean> {
  return await access(target).then(
    () => true,
    () => false
  );
}
