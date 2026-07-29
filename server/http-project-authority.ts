import { constants } from "node:fs";
import {
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import type { HttpListenerProject } from "./http-listener.js";
import {
  assertMachineTierOutsideDirectory,
  assertPathInsideDirectory,
  resolveProspectiveCanonicalPath
} from "./machine-tier-boundary.js";
import {
  retainedDirectoryAuthorityPath
} from "./retained-directory-authority.js";

const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number"
  ? constants.O_NOFOLLOW
  : 0;
const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;

export interface RetainedHttpProject {
  readonly authority: HttpListenerProject;
  readonly canonical: HttpListenerProject;
  release(): Promise<void>;
}

/**
 * Retain the selected project root before service startup.
 *
 * The factory uses the retained path. A later path replacement cannot move
 * service startup into the machine tier.
 */
export async function retainHttpProject(
  project: HttpListenerProject,
  machineDirectory: string
): Promise<RetainedHttpProject> {
  const [canonicalRoot, canonicalDataDir] = await Promise.all([
    resolveProspectiveCanonicalPath(project.root),
    resolveProspectiveCanonicalPath(project.dataDir)
  ]);
  await assertPathInsideDirectory(
    canonicalRoot,
    canonicalDataDir,
    "HTTP project data directory must be inside its project"
  );
  await assertMachineTierOutsideDirectory(
    canonicalRoot,
    machineDirectory,
    "HTTP server mode requires the machine tier outside the project"
  );

  let handle: FileHandle | undefined;
  try {
    const retainedAncestor = await openExistingAncestor(canonicalRoot);
    handle = retainedAncestor.handle;
    const canonicalAncestor = await realpath(retainedAncestor.path);
    const authorityAncestor = retainedDirectoryAuthorityPath(
      canonicalAncestor,
      handle.fd
    );
    if (await realpath(authorityAncestor) !== canonicalAncestor) {
      throw new Error(
        "HTTP project ancestor changed during authority acquisition"
      );
    }
    const relativeRoot = path.relative(canonicalAncestor, canonicalRoot);
    const authorityRoot = path.join(authorityAncestor, relativeRoot);
    await assertMachineTierOutsideDirectory(
      authorityRoot,
      machineDirectory,
      "HTTP server mode requires the machine tier outside the project"
    );
    const relativeDataDir = path.relative(canonicalRoot, canonicalDataDir);
    const authority = Object.freeze({
      root: authorityRoot,
      dataDir: path.join(authorityRoot, relativeDataDir)
    });
    const canonical = Object.freeze({
      root: canonicalRoot,
      dataDir: path.join(canonicalRoot, relativeDataDir)
    });
    return {
      authority,
      canonical,
      release: async () => {
        const retained = handle;
        handle = undefined;
        await retained?.close();
      }
    };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function openExistingAncestor(
  input: string
): Promise<{ readonly handle: FileHandle; readonly path: string }> {
  let candidate = input;
  while (true) {
    try {
      return {
        handle: await open(
          candidate,
          constants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG
        ),
        path: candidate
      };
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(
      `1667 cannot retain an ancestor for ${input}`
    );
    candidate = parent;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
