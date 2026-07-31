import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { lockedActiveVersion } from "../src/managed-install-mutation.js";
import {
  MANAGED_TEST_CURRENT as CURRENT,
  MANAGED_TEST_TARGET as TARGET,
  managedScratchRoot,
  shellManagedAuthority,
  writeManagedStub
} from "./managed-package-fixture.js";

/**
 * The refusal reaches human stderr and the `--json` envelope, and it is the
 * only guidance a person gets in this state. It must name what to remove: the
 * Install Root is often ~/.local/bin, so advice to remove a directory can
 * destroy unrelated programs.
 */
test("a target mismatch names both 1667-owned files and no directory", async () => {
  const root = managedScratchRoot("target-mismatch-");
  try {
    const { authority, paths } = shellManagedAuthority(root, "stable", CURRENT, TARGET);
    // The active executable now reports a target the Ownership Record does not.
    const otherTarget = TARGET === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    writeManagedStub(paths.active, CURRENT, otherTarget);

    let message = "";
    try {
      await lockedActiveVersion(authority, paths.active, AbortSignal.timeout(30_000));
      throw new Error("the mismatch was accepted");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(otherTarget);
    expect(message).toContain(TARGET);
    // Both files this installation owns, by exact path.
    expect(message).toContain(paths.active);
    expect(message).toContain(paths.ownership);
    // Never the Install Root on its own, and never a directory instruction.
    expect(message).not.toContain("Remove that directory");
    expect(message).not.toContain(`Remove ${root},`);
    expect(message).not.toContain(`Remove ${root} `);
    // Plain language only.
    for (const internal of ["Ownership Record", "Managed Installation", "Candidate"]) {
      expect(message).not.toContain(internal);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
