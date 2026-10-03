import { createManuscriptModel, type ManuscriptModel } from "../../../shared/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";

const models = new WeakMap<StoryPayload, ManuscriptModel>();

/**
 * The manuscript model of a payload, built once per payload object. The web
 * never changes a payload in place (every change adopts a new payload), so
 * the cache is safe here. The shared `createManuscriptModel` stays
 * unmemoized because the TUI does change payloads in place.
 */
export function manuscriptModelOf(payload: StoryPayload): ManuscriptModel {
  let model = models.get(payload);
  if (model === undefined) {
    model = createManuscriptModel(payload);
    models.set(payload, model);
  }
  return model;
}
