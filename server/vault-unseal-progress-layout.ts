import path from "node:path";

export const VAULT_UNSEAL_PROGRESS_DIRECTORY = ".1667-vault-unseal-progress";

const PROGRESS_FILE = /^[a-f0-9]{64}\.json$/;
const PRIVATE_PUBLICATION_SCRATCH_SUFFIX = ".1667-publish-v1.tmp";
const PRIVATE_REPLACEMENT_SUFFIX = ".1667-replace-v1.next";

/** True for the exact transient progress directory and its typed file residue. */
export function isVaultUnsealProgressPath(root: string, fileOrRelative: string): boolean {
  const relative = path.isAbsolute(fileOrRelative)
    ? path.relative(path.resolve(root), path.resolve(fileOrRelative))
    : fileOrRelative;
  if (relative === VAULT_UNSEAL_PROGRESS_DIRECTORY) return true;
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return false;
  return path.dirname(relative) === VAULT_UNSEAL_PROGRESS_DIRECTORY
    && canonicalProgressName(path.basename(relative)) !== null;
}

export function canonicalVaultUnsealProgressName(name: string): string | null {
  return canonicalProgressName(name);
}

function canonicalProgressName(name: string): string | null {
  if (PROGRESS_FILE.test(name)) return name;
  if (name.endsWith(PRIVATE_REPLACEMENT_SUFFIX)) {
    const replacementTarget = name.slice(0, -PRIVATE_REPLACEMENT_SUFFIX.length);
    return PROGRESS_FILE.test(replacementTarget) ? replacementTarget : null;
  }
  if (!name.endsWith(PRIVATE_PUBLICATION_SCRATCH_SUFFIX)) return null;
  const publicationTarget = name.slice(0, -PRIVATE_PUBLICATION_SCRATCH_SUFFIX.length);
  if (PROGRESS_FILE.test(publicationTarget)) return publicationTarget;
  if (!publicationTarget.endsWith(PRIVATE_REPLACEMENT_SUFFIX)) return null;
  const replacementTarget = publicationTarget.slice(0, -PRIVATE_REPLACEMENT_SUFFIX.length);
  return PROGRESS_FILE.test(replacementTarget) ? replacementTarget : null;
}
