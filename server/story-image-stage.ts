/**
 * The whole staging path from Source Image bytes to a Draft Image Record:
 * normalize in a dedicated child process, then claim one story `ioQueue`
 * turn to store the Normalized Image and publish its Draft Lease.
 *
 * This module holds no permit and no HTTP or worker-transport code. Each
 * transport's own dispatch site (server/http-router.ts,
 * server/worker-request-executor.ts) acquires the process-wide image stage
 * permit (server/image-stage-permit.ts) around a call to this function, so
 * the permit's held span always covers exactly "normalize, then store, then
 * publish" regardless of which transport is calling.
 */
import { launchImageNormalizeChild } from "./image-normalize-launcher.js";
import type { StoryStore } from "./stories.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";

export interface StagedDraftImage {
  readonly leaseId: string;
  readonly attachment: StoryImageAttachment;
}

export async function stageStoryImage(
  stories: StoryStore,
  storyId: string,
  declaredMediaType: string,
  sourceBytes: Uint8Array
): Promise<StagedDraftImage> {
  const normalized = await launchImageNormalizeChild(sourceBytes, declaredMediaType);
  return await stories.stageImage(storyId, normalized);
}
