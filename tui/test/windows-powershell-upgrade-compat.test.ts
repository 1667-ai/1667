import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import { INSTALL_OWNERSHIP_FILE } from "../../shared/install-ownership-record.js";
import { startWindowsUpgradeHandoff } from "../src/windows-upgrade-handoff.js";
import { HANDOFF_SCRIPT } from "../src/windows-upgrade-handoff-script.js";
import { WINDOWS_UPGRADE_FAILURE_FILE } from "../src/windows-upgrade-state.js";
import {
  removeWindowsHandoffScratch,
  windowsTestExecutable
} from "./windows-powershell-upgrade-fixture.js";

const CURRENT = "1.2.3";
const NEXT = "2.0.0-beta.1";

test("the Windows helper validates SHA-256 without Get-FileHash", async () => {
  if (process.platform !== "win32") return;

  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-digest-test-"));
  try {
    const installRoot = path.join(scratch, "installed");
    const activePath = path.join(installRoot, "1667.exe");
    const workRoot = path.join(installRoot, ".1667-upgrade.digest-integration");
    const candidatePath = path.join(workRoot, "1667-candidate.exe");
    const ownershipPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
    const failurePath = path.join(installRoot, WINDOWS_UPGRADE_FAILURE_FILE);
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(activePath, windowsTestExecutable(scratch, CURRENT, "digest-current"));
    writeFileSync(candidatePath, windowsTestExecutable(scratch, NEXT, "digest-candidate"));
    writeFileSync(ownershipPath, `${JSON.stringify({
      schemaVersion: 1,
      product: "1667",
      installationId: "abcdef0123456789abcdef0123456789",
      method: "powershell",
      channel: "stable",
      installRoot,
      executable: activePath,
      artifactTarget: "windows-x64"
    })}\n`);
    const authority = {
      kind: "powershell" as const,
      channel: "stable" as const,
      installRoot,
      executable: activePath
    };

    await startWindowsUpgradeHandoff({
      authority,
      currentVersion: CURRENT,
      targetVersion: NEXT,
      channel: "beta",
      updateChannel: true,
      candidatePath,
      candidateSha256: "0".repeat(64),
      workRoot
    });
    await waitForFailureMarker(failurePath, workRoot);

    expect(readFileSync(path.join(workRoot, HANDOFF_SCRIPT), "utf8"))
      .not.toContain("Get-FileHash");
    expect(JSON.parse(readFileSync(failurePath, "utf8"))).toMatchObject({
      activeState: "unchanged",
      message: "Candidate SHA-256 digest changed before handoff."
    });
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(CURRENT);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
      channel: "stable"
    });
  } finally {
    await removeWindowsHandoffScratch(scratch);
  }
}, 45_000);

async function waitForFailureMarker(failurePath: string, workRoot: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(failurePath)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const helperError = path.join(workRoot, "error.txt");
  throw new Error(existsSync(helperError)
    ? readFileSync(helperError, "utf8").trim()
    : "Windows handoff did not report its digest failure");
}
