import { imageInputEntryPointsOpen } from "../../../shared/image-input-release.js";
import {
  IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE,
  currentImageInputCapability,
  imageInputRefusalMessage
} from "../../../shared/image-input-runtime.js";
import { MAX_SOURCE_IMAGE_BYTES } from "../../../shared/image-attachment.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { composeDraftOf, type StoryComposeDraft } from "../compose/state.js";
import { NOT_CONNECTED_TOAST } from "../story/story-policy.js";
import {
  IMAGE_KIND_TOAST,
  IMAGE_LIMIT_TOAST,
  IMAGE_TOO_BIG_TOAST,
  MAX_DRAFT_IMAGES,
  sniffImageType,
  type DraftImage
} from "./draft-image.js";

export interface ImageActions {
  /** Reads whether the writing route accepts an image, from the settings. The
   * composer asks when it opens, and again when the writer comes back from
   * the settings page. */
  refreshImageInput(): Promise<void>;
  /** Stages the files and puts them in the story's draft, in order. A refusal
   * is a toast and nothing else. */
  attachImages(storyId: string, files: readonly File[]): Promise<void>;
  /** Takes one image out of the draft and releases its lease. */
  removeImage(storyId: string, leaseId: string): void;
  /** The palette's "attach image": opens the file chooser when the route can
   * take an image, and says why not when it cannot. */
  requestAttach(): Promise<void>;
}

export const IMAGE_REWRITE_TOAST = "An image cannot go with a rewrite.";

type WriteDraft = (storyId: string, update: (draft: StoryComposeDraft) => StoryComposeDraft) => void;

export function createImageActions(store: Store<AppState>, writeDraft: WriteDraft): ImageActions {
  const setCompose = (update: (compose: AppState["compose"]) => AppState["compose"]): void =>
    store.set((state) => {
      const compose = update(state.compose);
      return compose === state.compose ? state : { ...state, compose };
    });

  async function refreshImageInput(): Promise<void> {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return;
    try {
      const resolution = currentImageInputCapability(await connection.api.getSettings());
      setCompose((compose) => ({ ...compose, imageInput: resolution }));
    } catch {
      // Unknown stays unknown: the button stays off, and the palette asks again.
    }
  }

  /** Why an attach is refused right now, or `null`. */
  function refusal(storyId: string): string | null {
    const state = store.get();
    if (!imageInputEntryPointsOpen()) return IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE;
    if (state.connection.kind !== "connected") return NOT_CONNECTED_TOAST;
    const resolution = state.compose.imageInput;
    if (resolution === null) return "Checking whether this model accepts an image. Try again.";
    if (resolution.support !== "supported") return imageInputRefusalMessage(resolution);
    if (composeDraftOf(state.compose, storyId).retake?.rewrite !== undefined) return IMAGE_REWRITE_TOAST;
    return null;
  }

  async function stage(storyId: string, file: File): Promise<DraftImage | null> {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return null;
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      pushToast(store, IMAGE_TOO_BIG_TOAST);
      return null;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = sniffImageType(bytes);
    if (mediaType === null) {
      pushToast(store, IMAGE_KIND_TOAST);
      return null;
    }
    try {
      const staged = await connection.api.stageStoryImage(storyId, mediaType, bytes);
      return {
        leaseId: staged.leaseId,
        attachment: staged.attachment,
        previewUrl: URL.createObjectURL(new Blob([bytes], { type: mediaType })),
        name: file.name
      };
    } catch (error) {
      pushToast(store, errorMessage(error));
      return null;
    }
  }

  return {
    refreshImageInput,

    attachImages: async (storyId, files) => {
      if (files.length === 0) return;
      await refreshImageInput();
      const refused = refusal(storyId);
      if (refused !== null) {
        pushToast(store, refused);
        return;
      }
      for (const file of files) {
        if (composeDraftOf(store.get().compose, storyId).images.length >= MAX_DRAFT_IMAGES) {
          pushToast(store, IMAGE_LIMIT_TOAST);
          return;
        }
        const image = await stage(storyId, file);
        if (image === null) continue;
        writeDraft(storyId, (draft) => (
          draft.images.length >= MAX_DRAFT_IMAGES ? draft : { ...draft, images: [...draft.images, image] }
        ));
      }
    },

    removeImage: (storyId, leaseId) => {
      const removed = composeDraftOf(store.get().compose, storyId).images.find((image) => image.leaseId === leaseId);
      if (removed === undefined) return;
      writeDraft(storyId, (draft) => ({ ...draft, images: draft.images.filter((image) => image.leaseId !== leaseId) }));
      URL.revokeObjectURL(removed.previewUrl);
      const connection = store.get().connection;
      // Releasing is idempotent and best effort: the chip is gone either way.
      if (connection.kind === "connected") void connection.api.releaseStoryImage(storyId, leaseId).catch(() => undefined);
    },

    requestAttach: async () => {
      const state = store.get();
      if (state.route.kind !== "story" || state.story.kind !== "loaded") return;
      await refreshImageInput();
      const refused = refusal(state.route.id);
      if (refused !== null) {
        pushToast(store, refused);
        return;
      }
      setCompose((compose) => ({ ...compose, attachSerial: compose.attachSerial + 1 }));
    }
  };
}
