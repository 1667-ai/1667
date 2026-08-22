import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Removes every ACL from a test fixture tree on Darwin, so a host that hands
 * out inherited allow entries cannot trip the machine tier's privacy scan
 * inside a fixture that this suite created itself.
 */
export async function stripInheritedAcl(directory: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("chmod", ["-RN", directory]);
  } catch {
    // A host without BSD ACL support leaves nothing to strip.
  }
}

/** Synchronous variant for module-load fixtures. */
export function stripInheritedAclSync(directory: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("chmod", ["-RN", directory], { stdio: "ignore" });
  } catch {
    // A host without BSD ACL support leaves nothing to strip.
  }
}
