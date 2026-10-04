import { isStoryPage } from "../app/router.js";
import type { AppState } from "../app/state.js";
import { registerCommands } from "../palette/registry.js";

/** Search needs a story page: the open story is what `this story` searches. */
export function searchAvailable(state: AppState): boolean {
  const { route, story } = state;
  return isStoryPage(route) && story.kind === "loaded" && story.payload.id === route.id;
}

registerCommands([
  {
    id: "search",
    title: "search",
    description: "search this story or the whole vault",
    section: "view",
    shortcut: "/",
    available: ({ state }) => searchAvailable(state),
    run: ({ actions }) => actions.overlay.open("search")
  }
]);
