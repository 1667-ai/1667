/**
 * Draft Image staging and release, over HTTP: `POST .../images` and
 * `DELETE .../images/:leaseId`. Mirrors `api-import-methods.ts`'s shape,
 * one small module for one small family of calls, kept apart from the large
 * `createApi` closure in `api.ts`.
 *
 * Both calls are non-mutating worker methods (settled decision: staging is
 * not a story mutation). Neither carries a `mutationId` or an
 * `expectedAggregateVersion`, matching `getTokenProbabilities` and
 * `getReasoning`'s read-route shape, not the mutation shape `importLorebook`
 * and `importCard` use.
 */
import {
  createStoryImageAttachment,
  IMAGE_STAGE_DEADLINE_MS,
  isDraftImageLeaseId,
  type SourceImageMediaType,
  type StoryImageAttachment
} from "../../shared/image-attachment.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { StoryApi } from "./api.js";

export type ImageMethods = Pick<StoryApi, "stageStoryImage" | "releaseStoryImage">;

/** What the image methods borrow from the API they belong to. Mirrors the
 *  real `request` closure's full signature (api.ts), so an image call can
 *  reach `binaryContentType`, its last positional parameter, without either
 *  side narrowing what the other accepts. Both calls here always leave
 *  `expectedAggregateVersion`, `callerSignal`, and `mutationId` at
 *  `undefined`: staging and release are non-mutating worker methods, and
 *  the HTTP reservation layer rejects any of those three on a non-mutating
 *  route. */
export interface ImageMethodCore {
  request<T>(
    method: string,
    path: string,
    decode: (payload: unknown) => T,
    body?: unknown,
    timeoutMs?: number,
    expectedAggregateVersion?: StoryAggregateVersion,
    callerSignal?: AbortSignal,
    mutationId?: string,
    binaryContentType?: string
  ): Promise<T>;
}

export function imageMethods(core: ImageMethodCore): ImageMethods {
  return {
    stageStoryImage: async (storyId, mediaType, bytes) => await core.request(
      "POST",
      `/api/stories/${storyId}/images`,
      decodeStagedDraftImage,
      bytes,
      IMAGE_STAGE_DEADLINE_MS,
      undefined,
      undefined,
      undefined,
      mediaType
    ),
    releaseStoryImage: async (storyId, leaseId) => {
      await core.request(
        "DELETE",
        `/api/stories/${storyId}/images/${leaseId}`,
        () => undefined
      );
    }
  };
}

function decodeStagedDraftImage(
  value: unknown
): { leaseId: string; attachment: StoryImageAttachment } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The server returned an invalid staged image response.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.leaseId !== "string" || !isDraftImageLeaseId(record.leaseId)) {
    throw new Error("The server returned an invalid Draft Lease id.");
  }
  try {
    return {
      leaseId: record.leaseId,
      attachment: createStoryImageAttachment(record.attachment)
    };
  } catch (error) {
    throw new Error(
      `The server returned an invalid image attachment.${
        error instanceof Error ? ` ${error.message}` : ""
      }`
    );
  }
}

export type { SourceImageMediaType };
