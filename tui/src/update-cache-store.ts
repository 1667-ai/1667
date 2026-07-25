import path from "node:path";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile
} from "../../server/private-file-publication.js";
import {
  resolvePrivatePlatformStateRoot,
  type PlatformStateRootOptions
} from "../../server/platform-state-root.js";
import {
  encodeUpdateCache,
  readUpdateCacheHint,
  type UpdateCacheEntry,
  type UpdateCacheKey
} from "./update-cache.js";

export const UPDATE_CACHE_FILE = "update-notification-cache.json";

const CACHE_POLICY = {
  label: "Update notification cache",
  maxBytes: 8 * 1024
} as const;

export interface UpdateCacheStoreOptions extends PlatformStateRootOptions {
  /** Tests and already-validated hosts may supply the retained private root. */
  readonly stateRoot?: string;
}

export async function readPersistedUpdateCache(
  key: UpdateCacheKey,
  now = Date.now(),
  options: UpdateCacheStoreOptions = {}
): Promise<UpdateCacheEntry | null> {
  try {
    const root = options.stateRoot
      ?? await resolvePrivatePlatformStateRoot(options);
    const bytes = await readOptionalPrivateFile(
      path.join(root, UPDATE_CACHE_FILE),
      CACHE_POLICY
    );
    return bytes === null ? null : readUpdateCacheHint(bytes, key, now);
  } catch {
    // Cache state is never authority. Unsafe or unavailable state is a miss.
    return null;
  }
}

export async function writePersistedUpdateCache(
  entry: UpdateCacheEntry,
  options: UpdateCacheStoreOptions = {}
): Promise<boolean> {
  try {
    const root = options.stateRoot
      ?? await resolvePrivatePlatformStateRoot(options);
    const file = path.join(root, UPDATE_CACHE_FILE);
    // A crash between removal and publication loses a hint only. The next
    // explicit/background check repopulates it from authoritative metadata.
    await removePrivateFile(file, CACHE_POLICY);
    await publishPrivateFileNoReplace(file, encodeUpdateCache(entry), CACHE_POLICY);
    return true;
  } catch {
    return false;
  }
}
