import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MACHINE_TIER_OVERRIDE_VARIABLE } from "../server/machine-tier.js";

const previousStateRoot = process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
const stateRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), "1667-root-test-state-"))
);
process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = stateRoot;
process.once("exit", () => {
  if (previousStateRoot === undefined) {
    delete process.env[MACHINE_TIER_OVERRIDE_VARIABLE];
  } else {
    process.env[MACHINE_TIER_OVERRIDE_VARIABLE] = previousStateRoot;
  }
  rmSync(stateRoot, { recursive: true, force: true });
});
