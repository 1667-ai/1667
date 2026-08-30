import type { StoryManifestV13 } from "./story-format.js";
import type { DeletedStoryEnvelope, LiveStoryEnvelope } from "./story-v6-types.js";

/** V14 is the envelope for the V13 branch-scoped Fact State content. */
export type LiveStoryManifestV14 = LiveStoryEnvelope<14, StoryManifestV13>;

export type DeletedStoryManifestV14 = DeletedStoryEnvelope<14>;

export type StoryManifestV14 = LiveStoryManifestV14 | DeletedStoryManifestV14;
