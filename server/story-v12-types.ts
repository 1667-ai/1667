import type { StoryManifestV11 } from "./story-format.js";
import type { DeletedStoryEnvelope, LiveStoryEnvelope } from "./story-v6-types.js";

/** V12 is the envelope for the V11 Aside-session manifest. */
export type LiveStoryManifestV12 = LiveStoryEnvelope<12, StoryManifestV11>;

export type DeletedStoryManifestV12 = DeletedStoryEnvelope<12>;

export type StoryManifestV12 = LiveStoryManifestV12 | DeletedStoryManifestV12;
