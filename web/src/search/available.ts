import { isStoryPage } from "../app/router.js";
import type { AppState } from "../app/state.js";

/** Search needs a story page: the open story is what `this story` searches. */
export function searchAvailable(state: AppState): boolean {
  const { route, story } = state;
  return isStoryPage(route) && story.kind === "loaded" && story.payload.id === route.id;
}
