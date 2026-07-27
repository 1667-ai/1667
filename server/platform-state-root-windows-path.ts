import {
  lstat,
  mkdir,
  realpath
} from "node:fs/promises";
import path from "node:path";

export interface WindowsPrivateDirectoryPlan {
  readonly candidates: readonly string[];
  readonly stableAncestors: readonly string[];
}

export async function prepareWindowsPrivateDirectoryPlan(
  root: string,
  trustedBase: string | undefined
): Promise<WindowsPrivateDirectoryPlan> {
  if (trustedBase === undefined) {
    const ancestors = directoryAncestors(root);
    await preflightExistingAncestors(ancestors);
    await mkdir(root, { recursive: true });
    await requireCanonicalWindowsDirectory(root);
    return {
      candidates: [root],
      stableAncestors: ancestors
    };
  }
  const trustedAncestors = directoryAncestors(trustedBase);
  await preflightExistingAncestors(trustedAncestors);
  const relative = path.win32.relative(trustedBase, root);
  if (relative === ""
    || path.win32.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.win32.sep}`)) {
    throw new Error("Windows private state root is outside its trusted base");
  }
  const components = relative.split(path.win32.sep);
  if (components.some((component) =>
    component === "" || component === "." || component === "..")) {
    throw new Error("Windows private state root has an invalid component");
  }
  let cursor = trustedBase;
  const candidates = components.map((component) => {
    cursor = path.win32.join(cursor, component);
    return cursor;
  });
  return {
    candidates,
    stableAncestors: trustedAncestors
  };
}

export async function requireCanonicalWindowsDirectory(
  directory: string
): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      `Windows private state path is a reparse point: ${directory}`
    );
  }
  const canonical = await realpath(directory);
  const canonicalInfo = await lstat(canonical);
  if (info.dev !== canonicalInfo.dev || info.ino !== canonicalInfo.ino) {
    throw new Error(
      `Windows private state path identity changed: ${directory}`
    );
  }
}

async function preflightExistingAncestors(
  ancestors: readonly string[]
): Promise<void> {
  for (const ancestor of ancestors) {
    try {
      await requireCanonicalWindowsDirectory(ancestor);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function directoryAncestors(directory: string): readonly string[] {
  const parsed = path.win32.parse(directory);
  const relative = directory.slice(parsed.root.length);
  let cursor = parsed.root;
  return relative.split(path.win32.sep)
    .filter((component) => component !== "")
    .map((component) => {
      cursor = path.win32.join(cursor, component);
      return cursor;
    });
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
