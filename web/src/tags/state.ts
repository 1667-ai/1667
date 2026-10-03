import { rememberedLeafId } from "../../../shared/story-model.js";
import type { StoryPayload, Tag, TagStatus } from "../../../shared/types.js";

/**
 * The tag popover (#409 step 7a): which line it is open on, and the name and
 * status the writer has typed for each line. The draft lives here, per
 * (story, line), so Esc, a re-render, or a refused save never loses it; a save
 * that goes through clears it.
 */
export interface TagTarget {
  readonly storyId: string;
  /** The tagged line's leaf. */
  readonly nodeId: string;
  /** Where the keyboard goes when the popover closes. */
  readonly returnTo: "chip" | "part";
}

export interface TagDraft {
  readonly name: string;
  readonly status: TagStatus;
}

export interface TagsState {
  readonly open: TagTarget | null;
  readonly drafts: Readonly<Record<string, TagDraft>>;
  /** A save or delete is in flight. */
  readonly busy: boolean;
}

export function initialTagsState(): TagsState {
  return { open: null, drafts: {}, busy: false };
}

export function tagDraftKey(storyId: string, nodeId: string): string {
  return `${storyId}:${nodeId}`;
}

/** The tag a line already has, if any. */
export function tagOf(payload: StoryPayload, nodeId: string): Tag | null {
  return payload.tags.find((tag) => tag.nodeId === nodeId) ?? null;
}

/** What the popover shows for a line: the writer's draft, or else the tag the
 * line has. */
export function tagDraftOf(state: TagsState, payload: StoryPayload, target: TagTarget): TagDraft {
  const draft = state.drafts[tagDraftKey(target.storyId, target.nodeId)];
  if (draft !== undefined) return draft;
  const tag = tagOf(payload, target.nodeId);
  return { name: tag?.name ?? "", status: tag?.status ?? "" };
}

/** True while `nodeId` is still the end of its line: nothing grew below it. */
export function stillLineEnd(payload: StoryPayload, nodeId: string): boolean {
  return payload.nodes.some((node) => node.id === nodeId) && rememberedLeafId(payload, nodeId) === nodeId;
}
