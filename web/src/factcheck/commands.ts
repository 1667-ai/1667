import { registerCommands, type CommandContext } from "../palette/registry.js";

function onStoryPage({ state }: CommandContext): boolean {
  return state.route.kind === "story" && state.route.map !== true
    && state.story.kind === "loaded" && state.story.payload.id === state.route.id;
}

/** As the TUI: the check needs a Fact to check against, and the editor is not open. */
function canCheck(context: CommandContext): boolean {
  const { state } = context;
  return onStoryPage(context) && state.story.kind === "loaded" && state.story.payload.facts.length > 0
    && state.facts.editor === null;
}

registerCommands([
  {
    id: "check-chapter-against-facts",
    title: "check chapter against Facts",
    description: "find contradictions in the focused chapter without changing prose",
    section: "story",
    available: canCheck,
    run: (context) => void context.actions.factCheck.start("chapter")
  },
  {
    id: "check-story-line-against-facts",
    title: "check story line against Facts",
    description: "find contradictions in the selected story line without changing prose",
    section: "story",
    available: canCheck,
    run: (context) => void context.actions.factCheck.start("story-line")
  },
  {
    id: "show-fact-findings",
    title: "show Fact findings",
    description: "reopen the latest Fact consistency findings",
    section: "story",
    available: (context) => onStoryPage(context) && context.state.story.kind === "loaded"
      && context.state.story.payload.hasFactConsistencyRun === true && context.state.facts.editor === null,
    run: (context) => void context.actions.factCheck.show()
  }
]);
