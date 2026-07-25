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

export type ProjectSource = "discovered" | "explicit" | "global";

export interface ResolvedProject {
  /** Folder holding the project tier; the machine tier root when global. */
  readonly root: string;
  /** The project tier itself. Canonical when it exists; where it would be
   * created otherwise, which is why `exists` decides and not the path. */
  readonly directory: string;
  readonly source: ProjectSource;
  readonly exists: boolean;
}

export interface ProjectRequest {
  readonly cwd: string;
  readonly data?: string | undefined;
  readonly global?: boolean;
  readonly machineRoot?: string | undefined;
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

/**
 * The one place a project tier comes into existence. Every caller that decides
 * a project should exist routes through here, so none of them can create one
 * without the `.gitignore` that keeps machine-local files out of a commit.
 */
export async function createProjectTier(directory: string): Promise<string> {
  // 1667 creates this directory, so it keeps it private — the same 0700 the
  // lock repairs on every open. Git carries no modes, so a clone that arrives
  // as 0755 is repaired rather than refused.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, PROJECT_GITIGNORE_FILE),
    projectGitignoreContent(),
    { flag: "wx" }
  ).catch((error: unknown) => {
    if (!isErrorCode(error, "EEXIST")) throw error;
  });
  return await realpath(directory);
}

/** Create the project tier in root. Safe to call on an existing project. */
export async function initializeProject(root: string): Promise<ResolvedProject> {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    directory: await createProjectTier(projectDirectory(absoluteRoot)),
    source: "explicit",
    exists: true
  };
}

/**
 * Report which project this invocation names. Pure: it never creates anything,
 * so a caller that needs the project to exist already can refuse, and a caller
 * that means to create one says so by calling `createProjectTier`.
 */
export async function resolveProject(
  request: ProjectRequest
): Promise<ProjectOutcome> {
  if (request.global === true) {
    if (request.data !== undefined) {
      throw new Error("--global and --data select different projects");
    }
    // Resolving the machine tier prepares 1667's own state directory. That is
    // not the project tier, and it happens whether or not a project follows.
    const machineRoot = await resolveMachineTierRoot(
      request.machineRoot === undefined ? {} : { override: request.machineRoot }
    );
    return {
      kind: "project",
      project: await describe(
        machineRoot,
        path.join(machineRoot, GLOBAL_PROJECT_DIRECTORY_NAME),
        "global"
      )
    };
  }
  if (request.data !== undefined) {
    const root = path.resolve(request.cwd, request.data);
    return {
      kind: "project",
      project: await describe(root, projectDirectory(root), "explicit")
    };
  }
  const discovered = await findProjectRoot(request.cwd);
  if (discovered === null) return { kind: "absent", cwd: path.resolve(request.cwd) };
  return {
    kind: "project",
    project: await describe(discovered, projectDirectory(discovered), "discovered")
  };
}

async function describe(
  root: string,
  directory: string,
  source: ProjectSource
): Promise<ResolvedProject> {
  const exists = await isDirectory(directory);
  return {
    root,
    directory: exists ? await realpath(directory) : directory,
    source,
    exists
  };
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
