import {
  resolveProject,
  type ProjectRequest,
  type ResolvedProject
} from "../../server/project-discovery.js";
import { PROJECT_DIRECTORY_NAME } from "../../server/project-layout.js";
import { plainTerminalText as plain } from "../../shared/terminal-text.js";

/** The project selection every import command accepts. */
export interface ProjectSelection {
  readonly data: string | null;
  readonly global: boolean;
}

/** Find the project an import command writes to, or refuse with the reason.
 * Both import commands share this wording, so neither can drift from it. */
export async function resolveImportProject(
  selection: ProjectSelection
): Promise<ResolvedProject> {
  const outcome = await resolveProject(projectRequest(selection));
  if (outcome.kind === "absent") {
    throw new Error(
      `no ${PROJECT_DIRECTORY_NAME} story project in ${plain(outcome.cwd)} or any parent, `
        + "so there is nowhere to import. Run '1667 init' first."
    );
  }
  const project = outcome.project;
  if (!project.exists) {
    throw new Error(
      `${plain(project.directory)} is not a 1667 story project yet, so there is `
        + "nowhere to import. Run '1667 init' there first."
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
