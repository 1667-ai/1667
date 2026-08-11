import type { StoryManifestV7 } from "./story-format.js";
import type { DeletedStoryEnvelope, LiveStoryEnvelope } from "./story-v6-types.js";

/**
 * The successor envelope. Every field means exactly what it means on
 * `LiveStoryManifestV6` / `DeletedStoryManifestV6`: same scalar shapes, same
 * summary shape, same pointer shapes, because a schema version identifies
 * one document shape, and only `content` (and, inside it, `nodes[]`) is
 * where the successor actually differs. `LiveStoryEnvelope` and
 * `DeletedStoryEnvelope` (`server/story-v6-types.ts`) carry the shared field
 * list; this file only names the version and the content payload.
 */
export type LiveStoryManifestV8 = LiveStoryEnvelope<8, StoryManifestV7>;

export type DeletedStoryManifestV8 = DeletedStoryEnvelope<8>;

export type StoryManifestV8 = LiveStoryManifestV8 | DeletedStoryManifestV8;
