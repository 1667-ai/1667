import type { StoryManifestV15 } from "./story-format.js";
import type { DeletedStoryEnvelope, LiveStoryEnvelope } from "./story-v6-types.js";

/** V16 is the envelope for the V15 Fact consistency content payload. */
export type LiveStoryManifestV16 = LiveStoryEnvelope<16, StoryManifestV15>;

export type DeletedStoryManifestV16 = DeletedStoryEnvelope<16>;

export type StoryManifestV16 = LiveStoryManifestV16 | DeletedStoryManifestV16;
