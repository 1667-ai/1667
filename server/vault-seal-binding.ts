import path from "node:path";
import { isObjectKind, OBJECT_EXTENSIONS } from "./story-object-layout.js";
import { isStoryId } from "./story-v5-strict.js";

/**
 * The value a sealed vault file authenticates itself against, so a ciphertext
 * cannot be read at a location it was not sealed for. The seal binds this
 * value as AES-GCM additional authenticated data, which makes an attacker who
 * can write into a sealed vault unable to move one file's ciphertext onto
 * another file's name: the authentication tag fails instead of handing the
 * reader plaintext in a context that may export or transmit it.
 *
 * Two bindings exist because the vault holds two kinds of payload.
 *
 * A content-addressed story object binds its kind and its content hash, not
 * its path. `StoryObjectStore` publishes one identical object into several
 * stories as hard links to a single inode (`server/story-objects.ts`), so one
 * ciphertext is legitimately reachable at several vault-relative paths and a
 * path binding would break that reuse. The kind and hash are already declared
 * by the file's own name, so this binding is the stronger of the two: a
 * ciphertext can only be read at a name that states its own content hash.
 * Relocating an object to the same hash under another story stays possible and
 * carries no information, because identical hashes mean identical bytes.
 *
 * Every other payload binds its vault-relative path. These files are never
 * hard-linked by 1667.
 *
 * Both bindings are stable across operating systems: the path is encoded with
 * `/` separators so a vault sealed on Windows opens on macOS and Linux.
 */

const OBJECT_BINDING_DOMAIN = "1667-vault-object-v1";
const PATH_BINDING_DOMAIN = "1667-vault-path-v1";
const STORY_DIRECTORY = "stories";
const OBJECT_PATH_PARTS = 5;
const OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Derive the binding for one path relative to its vault root. */
export function vaultSealBinding(relative: string): Buffer {
  const parts = relative.split(path.sep);
  const object = objectIdentity(parts);
  return object === null
    ? Buffer.from(`${PATH_BINDING_DOMAIN}\0${parts.join("/")}`, "utf8")
    : Buffer.from(
        `${OBJECT_BINDING_DOMAIN}\0${object.kind}\0${object.hash}`,
        "utf8"
      );
}

interface ObjectIdentity {
  readonly kind: string;
  readonly hash: string;
}

/**
 * Classify `stories/<story id>/<kind>/<shard>/<hash><extension>` and nothing
 * else. The shard must be the hash's own first two characters and the
 * extension must be the one its kind declares, so a file that only resembles
 * an object path keeps the path binding.
 */
function objectIdentity(parts: readonly string[]): ObjectIdentity | null {
  if (parts.length !== OBJECT_PATH_PARTS) return null;
  const [directory, storyId, kind, shard, name] = parts as [
    string,
    string,
    string,
    string,
    string
  ];
  if (directory !== STORY_DIRECTORY || !isStoryId(storyId)) return null;
  if (!isObjectKind(kind)) return null;
  const extension = OBJECT_EXTENSIONS[kind];
  if (!name.endsWith(extension)) return null;
  const hash = name.slice(0, name.length - extension.length);
  if (!OBJECT_HASH_PATTERN.test(hash) || shard !== hash.slice(0, 2)) return null;
  return { kind, hash };
}
