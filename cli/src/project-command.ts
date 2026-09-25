import {
  resolveExistingProject as resolveHostProject,
  requireExistingProject,
  type ExistingProjectOperation,
  type ExistingProjectRequirement,
  type ProjectSelection
} from "../../host/launcher-project.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";

export type { ExistingProjectOperation, ExistingProjectRequirement, ProjectSelection };
export { requireExistingProject };

/** Resolve an existing project for a terminal command. */
export async function resolveExistingProject(
  selection: ProjectSelection,
  operation: ExistingProjectOperation
) {
  return await resolveHostProject(selection, operation, plain);
}

/** Read the value after a separated flag. Another flag is never a value. */
export function separatedValue(
  argv: readonly string[],
  index: number,
  flag: string
): string {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Read the value out of a `--flag=value` argument. */
export function inlineValue(argument: string, flag: string): string {
  const value = argument.slice(flag.length + 1);
  if (value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
