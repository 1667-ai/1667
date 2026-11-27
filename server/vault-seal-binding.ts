import path from "node:path";
import { isObjectKind, OBJECT_EXTENSIONS } from "./story-object-layout.js";

/**
 * The value a sealed story object authenticates itself against, so a
 * ciphertext cannot be read at a location it was not sealed for. The seal
 * binds this value as AES-GCM additional authenticated data, which makes an
 * attacker who can write into a sealed vault unable to move one object's
 * ciphertext onto another object's name: the authentication tag fails instead
 * of handing the reader plaintext in a context that may export or transmit it.
 *
 * Only content-addressed story objects carry a binding. They hold the prose,
 * they are immutable, and their names already declare their own content hash,
 * so the binding is both the valuable case and the natural one.
 *
 * An object binds its kind and hash, never its path. `StoryObjectStore`
 * publishes one identical object into several stories as hard links to a
 * single inode (`server/story-objects.ts`), so one ciphertext is legitimately
 * reachable at several vault-relative paths and a path binding would break
 * that reuse. Relocating an object to the same hash under another story stays
 * possible and carries no information, because identical hashes mean
 * identical bytes.
 *
 * Because the binding holds no part of the path above the object, nothing here
 * reads that part either. Only the last three components decide. 1667 renames
 * the directories above an object during normal work — `server/story-reaper.ts`
 * moves a whole bundle to `.1667-story-reap-h1_<token>` before it removes the
 * children, and an interrupted deletion leaves objects there — and an object
 * has to keep its binding through every one of those moves.
 *
 * Every other payload is unbound. Those files are published through staging
 * names and renamed into place, so a path binding would authenticate the
 * staging name and then fail at the final name. A bound seal that reaches one
 * of these paths has no binding to check and is refused, which keeps the
 * failure closed rather than silently unbound.
 *
 * The binding is stable across operating systems: it holds no path separator,
 * so a vault sealed on Windows opens on macOS and Linux.
 */

const OBJECT_BINDING_DOMAIN = "1667-vault-object-v1";
const OBJECT_PATH_TAIL_PARTS = 3;
const OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Derive the binding for one path relative to its vault root, or null when
 * that path takes no binding.
 */
export function vaultSealBinding(relative: string): Buffer | null {
  const object = objectIdentity(relative.split(path.sep));
  return object === null
    ? null
    : Buffer.from(`${OBJECT_BINDING_DOMAIN}\0${object.kind}\0${object.hash}`, "utf8");
}

interface ObjectIdentity {
  readonly kind: string;
  readonly hash: string;
}

/**
 * Classify a path whose last three components are
 * `<kind>/<shard>/<hash><extension>`, wherever those sit. The shard must be the
 * hash's own first two characters and the extension must be the one its kind
 * declares, so a file that only resembles an object path stays unbound. Every
 * staging name 1667 publishes through fails this shape, which is what keeps a
 * staged write out of the bound set.
 *
 * 1667 owns this layout, and no other file it writes carries an object kind,
 * a two-character shard that repeats its own name, and that kind's exact
 * extension, so the shape identifies an object on its own.
 */
function objectIdentity(parts: readonly string[]): ObjectIdentity | null {
  if (parts.length < OBJECT_PATH_TAIL_PARTS) return null;
  const [kind, shard, name] = parts.slice(-OBJECT_PATH_TAIL_PARTS) as [
    string,
    string,
    string
  ];
  if (!isObjectKind(kind)) return null;
  const extension = OBJECT_EXTENSIONS[kind];
  if (!name.endsWith(extension)) return null;
  const hash = name.slice(0, name.length - extension.length);
  if (!OBJECT_HASH_PATTERN.test(hash) || shard !== hash.slice(0, 2)) return null;
  return { kind, hash };
}
