import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveMachineTierRoot } from "./machine-tier.js";
import {
  PROJECT_DIRECTORY_NAME,
  PROJECT_GITIGNORE_FILE,
  projectDirectory,
  projectGitignoreContent
} from "./project-layout.js";

/** The machine tier's own project, for one library and no folders. */
const GLOBAL_PROJECT_DIRECTORY_NAME = "global";

export type ProjectSource = "discovered" | "created" | "explicit" | "global";

export interface ResolvedProject {
  /** Folder holding the project tier; the machine tier root when global. */
  readonly root: string;
  /** The project tier itself, resolved once so later opens follow no links. */
  readonly directory: string;
  readonly source: ProjectSource;
}

export interface ProjectRequest {
  readonly cwd: string;
  readonly data?: string | undefined;
  readonly global?: boolean;
  readonly machineRoot?: string | undefined;
  /** False reports what an ordinary start would open without writing. */
  readonly create?: boolean;
}

export type ProjectOutcome =
  | { readonly kind: "project"; readonly project: ResolvedProject }
  | { readonly kind: "absent"; readonly cwd: string };

/** Walk up for an existing project tier, stopping at the filesystem root. */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let cursor = path.resolve(startDir);
  for (;;) {
    if (await isDirectory(projectDirectory(cursor))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Create the project tier in root. Safe to call on an existing project. */
export async function initializeProject(
  root: string,
  source: ProjectSource = "created"
): Promise<ResolvedProject> {
  const absoluteRoot = path.resolve(root);
  const directory = projectDirectory(absoluteRoot);
  // The process umask decides the mode, exactly like `git init`: a project tier
  // may be committed, and a mode 1667 asserted would not survive the clone.
  await mkdir(directory, { recursive: true });
  const gitignore = path.join(directory, PROJECT_GITIGNORE_FILE);
  await writeFile(gitignore, projectGitignoreContent(), { flag: "wx" })
    .catch((error: unknown) => {
      if (!isErrorCode(error, "EEXIST")) throw error;
    });
  return {
    root: absoluteRoot,
    directory: await realpath(directory),
    source
  };
}

/**
 * Resolve which project this invocation opens. An explicit path is explicit
 * intent and is created; a bare start only reports an absent project, leaving
 * the prompt-or-refuse choice to the caller that owns the terminal.
 */
export async function resolveProject(
  request: ProjectRequest
): Promise<ProjectOutcome> {
  const create = request.create !== false;
  if (request.global === true) {
    if (request.data !== undefined) {
      throw new Error("--global and --data select different projects");
    }
    const machineRoot = await resolveMachineTierRoot(
      request.machineRoot === undefined ? {} : { override: request.machineRoot }
    );
    const directory = path.join(machineRoot, GLOBAL_PROJECT_DIRECTORY_NAME);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    return {
      kind: "project",
      project: {
        root: machineRoot,
        directory: await canonical(directory),
        source: "global"
      }
    };
  }
  if (request.data !== undefined) {
    const root = path.resolve(request.cwd, request.data);
    return {
      kind: "project",
      project: create
        ? await initializeProject(root, "explicit")
        : {
            root,
            directory: await canonical(projectDirectory(root)),
            source: "explicit"
          }
    };
  }
  const discovered = await findProjectRoot(request.cwd);
  if (discovered === null) return { kind: "absent", cwd: path.resolve(request.cwd) };
  return {
    kind: "project",
    project: {
      root: discovered,
      directory: await realpath(projectDirectory(discovered)),
      source: "discovered"
    }
  };
}

/** An absent path has no realpath; report where it would be created. */
async function canonical(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return directory;
    throw error;
  }
}

export { PROJECT_DIRECTORY_NAME };

async function isDirectory(target: string): Promise<boolean> {
  try {
    // Follows a link: the realpath recorded at open is the admission decision,
    // so a project reached through a symlink is ordinary, not suspicious.
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
