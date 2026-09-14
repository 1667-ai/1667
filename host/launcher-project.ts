import {
  resolveProject,
  type ProjectOutcome,
  type ProjectRequest,
  type ResolvedProject
} from "../server/project-discovery.js";
import {
  createProjectTier,
  initializeProject as initializeProjectDirectory
} from "../server/project-discovery.js";
import {
  adoptDataDirectory,
  type ProjectAdoption
} from "../server/project-adoption.js";
import { PROJECT_DIRECTORY_NAME } from "../server/project-layout.js";

/** The project selection shared by launcher commands and graphical callers. */
export interface ProjectSelection {
  readonly cwd?: string;
  readonly data: string | null;
  readonly global: boolean;
}

export type ExistingProjectOperation =
  | "import"
  | "export"
  | "encrypt"
  | "decrypt"
  | "profile";

export interface ExistingProjectRequirement {
  /** Text after "so there is" for an absent or uninitialized project. */
  readonly unavailable: string;
  /** Transform paths before they enter terminal or UI text. */
  readonly displayPath?: (value: string) => string;
}

/** Resolve the project selected by a launcher command. */
export async function resolveExistingProject(
  selection: ProjectSelection,
  operation: ExistingProjectOperation,
  displayPath?: (value: string) => string
): Promise<ResolvedProject> {
  const outcome = await resolveProject(projectRequest(selection));
  return requireExistingProject(outcome, {
    unavailable: unavailableProjectOperationText(operation),
    ...(displayPath === undefined ? {} : { displayPath })
  });
}

/** Reject absent and uninitialized projects without creating either one. */
export function requireExistingProject(
  outcome: ProjectOutcome,
  requirement: ExistingProjectRequirement
): ResolvedProject {
  const displayPath = requirement.displayPath ?? ((value: string) => value);
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

/** Initialize a project directory. The operation has no terminal behavior. */
export async function initializeProject(cwd: string): Promise<ResolvedProject> {
  return await initializeProjectDirectory(cwd);
}

/** Create the project tier for an explicit project selection. */
export async function createProject(dataDirectory: string): Promise<void> {
  await createProjectTier(dataDirectory);
}

/** Adopt machine state into a project without adding CLI output. */
export async function adoptProject(
  options: Parameters<typeof adoptDataDirectory>[0]
): Promise<ProjectAdoption> {
  return await adoptDataDirectory(options);
}

/** Keep the discovery request construction in one shared place. */
export function projectRequest(selection: ProjectSelection): ProjectRequest {
  return {
    cwd: selection.cwd ?? process.cwd(),
    ...(selection.data === null ? {} : { data: selection.data }),
    ...(selection.global ? { global: true } : {})
  };
}

function unavailableProjectOperationText(
  operation: ExistingProjectOperation
): string {
  switch (operation) {
    case "import": return "nowhere to import";
    case "export": return "nothing to export";
    case "encrypt": return "nothing to encrypt";
    case "decrypt": return "nothing to decrypt";
    case "profile": return "nowhere to change profiles";
  }
}
