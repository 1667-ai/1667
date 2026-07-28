import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { RuntimeDataDirectoryLock } from "../../server/runtime-data-directory.js";
import { releaseOrRetainDataLock } from "../src/worker-data-lock.js";
import {
  BACKEND_RESTART_REQUIRED_EXIT_CODE,
  BackendRestartRequiredError
} from "../src/worker-error.js";

describe("embedded worker hard fence", () => {
  test("retains the data lock through process teardown after restart-required failure", async () => {
    let releases = 0;
    const lock = {
      release: async () => { releases += 1; }
    } as RuntimeDataDirectoryLock;

    const error = new BackendRestartRequiredError("worker did not settle");
    await releaseOrRetainDataLock(lock, error);

    expect(releases).toBe(0);
    expect(error).toMatchObject({ code: "backend_restart_required" });
    expect(BACKEND_RESTART_REQUIRED_EXIT_CODE).toBe(75);
  });

  test("forces exit despite live event-loop work and emits one bounded restart instruction", () => {
    const moduleUrl = new URL("../src/worker-error.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--eval",
      `import { exitForBackendRestart } from ${JSON.stringify(moduleUrl)};`
        + "setInterval(() => undefined, 1000);"
        + "exitForBackendRestart();"
    ], {
      encoding: "utf8",
      timeout: 2_000
    });

    expect(child.status).toBe(BACKEND_RESTART_REQUIRED_EXIT_CODE);
    expect(child.signal).toBe(null);
    expect(child.stderr).toBe(
      "1667: the local backend stopped before it confirmed the last change. "
        + "Restart 1667. Saved state will be checked before more work is accepted.\n"
    );
  });

  test("prints a validated diagnostic reference through the hard fence", () => {
    const moduleUrl = new URL("../src/worker-error.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--eval",
      `import { BackendRestartRequiredError, exitForBackendRestart } from ${JSON.stringify(moduleUrl)};`
        + "exitForBackendRestart(new BackendRestartRequiredError('failed', "
        + "{ diagnosticRef: 'err_deadbeefdeadbeefdeadbeef' }));"
    ], {
      encoding: "utf8",
      timeout: 2_000
    });

    expect(child.status).toBe(BACKEND_RESTART_REQUIRED_EXIT_CODE);
    expect(child.stderr).toBe(
      "1667: the local backend stopped before it confirmed the last change. "
        + "Restart 1667. Saved state will be checked before more work is accepted. "
        + "Diagnostic reference: err_deadbeefdeadbeefdeadbeef.\n"
    );
  });

  test("releases the data lock for ordinary startup failure", async () => {
    let releases = 0;
    const lock = {
      release: async () => { releases += 1; }
    } as RuntimeDataDirectoryLock;

    await releaseOrRetainDataLock(lock, new Error("startup rejected"));

    expect(releases).toBe(1);
  });
});
