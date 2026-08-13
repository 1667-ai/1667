import type { StoryManifestV9 } from "./story-format.js";
import type { DeletedStoryEnvelope, LiveStoryEnvelope } from "./story-v6-types.js";

/**
 * The Aside envelope. Same fields as V6/V8; only schemaVersion and content
 * differ. Content is an exact V9 payload.
 */
export type LiveStoryManifestV10 = LiveStoryEnvelope<10, StoryManifestV9>;

export type DeletedStoryManifestV10 = DeletedStoryEnvelope<10>;

export type StoryManifestV10 = LiveStoryManifestV10 | DeletedStoryManifestV10;
