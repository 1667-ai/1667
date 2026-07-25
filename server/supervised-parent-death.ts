import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";

const PR_SET_PDEATHSIG = 1;
const SIGKILL = 9;

/** Install Linux kernel parent-death containment before application imports. */
export async function installSupervisorParentDeath(
  expectedParentPid: number
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(
      `Supervised serve parent-death containment is unavailable on ${process.platform}`
    );
  }
  if (process.versions.bun === undefined) {
    throw new Error("Supervised serve requires the packaged Bun runtime");
  }
  const ffi = await loadBunFfi();
  const libc = openPosixLibc(ffi, {
    prctl: {
      args: ["i32", "u64", "u64", "u64", "u64"],
      returns: "i32"
    }
  });
  try {
    const result = libc.symbols.prctl!(
      PR_SET_PDEATHSIG,
      SIGKILL,
      0,
      0,
      0
    );
    if (result !== 0) throw new Error("prctl(PR_SET_PDEATHSIG) failed");
    if (process.ppid !== expectedParentPid) {
      throw new Error("Supervisor changed during child containment setup");
    }
  } finally {
    libc.close();
  }
}
