import * as testRuntime from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MACHINE_TIER_OVERRIDE_VARIABLE } from "../../server/machine-tier.js";

const previousStateRoot = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
const testStateRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), "1667-tui-test-state-"))
);
process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = testStateRoot;

const afterAll = (testRuntime as unknown as {
  afterAll(cleanup: () => void): void;
}).afterAll;

afterAll(() => {
  if (previousStateRoot === undefined) {
    delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  } else {
    process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previousStateRoot;
  }
  rmSync(testStateRoot, { recursive: true, force: true });
});
