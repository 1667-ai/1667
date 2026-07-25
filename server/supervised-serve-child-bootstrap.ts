import { installSupervisorParentDeath } from "./supervised-parent-death.js";

export async function runSupervisedServeChildBootstrap(
  argv: readonly string[]
): Promise<void> {
  const parent = Number(valueAfter(argv, "--parent-pid"));
  if (!Number.isSafeInteger(parent) || parent <= 1) {
    throw new Error("Supervised child requires a valid --parent-pid");
  }
  await installSupervisorParentDeath(parent);
  const { runSupervisedServeChild } = await import("./supervised-serve-child.js");
  await runSupervisedServeChild(argv);
}
function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
