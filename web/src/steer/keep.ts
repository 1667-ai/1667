import type { StoryApi } from "../../../client/api.js";
import type { AppActions } from "../app/actions.js";
import { closeStoryPage } from "../app/router.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { failureToast, findCreatedPart, runStoryMutation } from "../app/story-mutation.js";
import { pushToast } from "../app/toasts.js";
import { storyChangeRefusal } from "../story/story-policy.js";

/** A kept part has no direction of its own in step 1: the preview sent the Default Continue direction. */
const KEEP_INSTRUCTION = "";

/**
 * Saves the shown words as a new part under the end of the story line, then
 * closes the steer page with focus on the new part. A refused or failed save
 * keeps the page open, so the words are not lost. Returns whether it saved.
 */
export async function keepPreview(
  store: Store<AppState>,
  actions: Pick<AppActions, "story">,
  api: StoryApi,
  storyId: string,
  parentId: string | null,
  text: string,
  /** The parts of the story before the save, to tell the new part from the old ones. */
  known: ReadonlySet<string>
): Promise<boolean> {
  const body = text.trim();
  if (body.length === 0) return false;
  const refusal = storyChangeRefusal(store.get(), storyId);
  if (refusal !== null) {
    pushToast(store, refusal);
    return false;
  }
  const outcome = await runStoryMutation(
    api,
    storyId,
    async () => ({ payload: await api.createNode(storyId, { parentId, text: body, instruction: KEEP_INSTRUCTION }) }),
    (reloaded) => (findCreatedPart(reloaded, known, parentId, KEEP_INSTRUCTION, body) === undefined ? null : {})
  );
  if (outcome.kind !== "saved") {
    if (outcome.kind !== "unresolved" && outcome.payload !== null) actions.story.adoptPayload(storyId, outcome.payload);
    pushToast(store, failureToast(outcome, "Keep"));
    return false;
  }
  const landed = findCreatedPart(outcome.payload, known, parentId, KEEP_INSTRUCTION, body);
  actions.story.adoptPayload(storyId, outcome.payload, landed === undefined ? {} : { focus: { kind: "part", partId: landed.id } });
  closeStoryPage(storyId);
  return true;
}
