import { registerCommands, type CommandContext } from "../palette/registry.js";

function onStoryPage({ state }: CommandContext): boolean {
  return state.route.kind === "story" && state.route.map !== true
    && state.story.kind === "loaded" && state.story.payload.id === state.route.id;
}

registerCommands([
  {
    id: "import-card",
    title: "import character card",
    description: "add the Facts of a character card (.json or .png) to this story",
    section: "story",
    available: onStoryPage,
    run: (context) => context.actions.imports.pickCard()
  },
  {
    id: "import-archive",
    title: "import archive",
    description: ".lorebook .json → Facts · .scenario .story → new story",
    section: "story",
    available: onStoryPage,
    run: (context) => context.actions.imports.pickArchive()
  }
]);
