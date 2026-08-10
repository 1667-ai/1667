import {
  resolveProject,
  type ProjectOutcome,
  type ProjectRequest,
  type ResolvedProject
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";

/** The project selection every import and export command accepts. */
export interface ProjectSelection {
  readonly data: string | null;
  readonly global: boolean;
}

export type ExistingProjectOperation = "import" | "export" | "encrypt" | "decrypt";

export interface ExistingProjectRequirement {
  /** Text after "so there is" for an absent or uninitialized project. */
  readonly unavailable: string;
  /** Terminal-safe path text for commands that print paths from their input. */
  readonly displayPath?: (path: string) => string;
}

/** Resolve an existing project for a command that must not create one. */
export async function resolveExistingProject(
  selection: ProjectSelection,
  operation: ExistingProjectOperation
): Promise<ResolvedProject> {
  const outcome = await resolveProject(projectRequest(selection));
  return requireExistingProject(outcome, {
    unavailable: unavailableProjectOperationText(operation),
    displayPath: plain
  });
}

function unavailableProjectOperationText(operation: ExistingProjectOperation): string {
  switch (operation) {
    case "import": return "nowhere to import";
    case "export": return "nothing to export";
    case "encrypt": return "nothing to encrypt";
    case "decrypt": return "nothing to decrypt";
  }
}

/** Reject absent and uninitialized projects without creating either one. */
export function requireExistingProject(
  outcome: ProjectOutcome,
  requirement: ExistingProjectRequirement
): ResolvedProject {
  const displayPath = requirement.displayPath ?? ((path: string) => path);
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${displayPath(outcome.cwd)} or any parent, `
        + `so there is ${requirement.unavailable}. Run '1667 init' first.`
    );
  }
  const project = outcome.project;
  if (!project.exists) {
    throw new Error(
      `${displayPath(project.directory)} is not a 1667 story project yet, so there is `
        + `${requirement.unavailable}. Run '1667 init' there first.`
    );
  }
  return project;
}

/** Read the value after a separated flag. Another flag is never a value:
 * `--data --global` is a typo, not a project called `--global`. */
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

function projectRequest(selection: ProjectSelection): ProjectRequest {
  return {
    cwd: process.cwd(),
    ...(selection.data === null ? {} : { data: selection.data }),
    ...(selection.global ? { global: true } : {})
  };
}
