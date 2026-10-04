import { registerCommands } from "../palette/registry.js";

/** Focuses the Library's title filter, once the drawer (below ~800px) has opened. */
function focusLibrary(openLibrary: () => void): void {
  openLibrary();
  setTimeout(() => {
    document.querySelector<HTMLInputElement>('input[aria-label="Search stories"]')?.focus();
  }, 0);
}

registerCommands([
  {
    id: "new-story",
    title: "new story",
    description: "start an empty story",
    section: "story",
    run: (context) => void context.actions.library.create()
  },
  {
    id: "rename-story",
    title: "rename story",
    description: "change the current story title",
    section: "story",
    available: ({ state }) => state.route.kind === "story" && state.story.kind === "loaded",
    run: ({ state, actions }) => {
      if (state.story.kind === "loaded") actions.library.startRename(state.story.payload.id, state.story.payload.title);
    }
  },
  {
    id: "switch-story",
    title: "switch story",
    description: "open another story from the library",
    section: "story",
    shortcut: "o",
    run: (context) => focusLibrary(context.openLibrary)
  }
]);
