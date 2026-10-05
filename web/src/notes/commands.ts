import { isStoryPage } from "../app/router.js";
import { registerCommands, type CommandContext } from "../palette/registry.js";

function onStoryPage({ state }: CommandContext): boolean {
  return isStoryPage(state.route)
    && state.story.kind === "loaded" && state.story.payload.id === state.route.id;
}

registerCommands([
  {
    id: "authors-note",
    title: "author's note",
    description: "steer the next passage with style, tone, or current truth",
    section: "story",
    shortcut: "n",
    available: onStoryPage,
    run: (context) => context.actions.notes.open("note")
  },
  {
    id: "author-brief",
    title: "author brief",
    description: "override the machine-wide author brief for this story",
    section: "story",
    available: onStoryPage,
    run: (context) => context.actions.notes.open("brief")
  },
  {
    id: "autoname",
    title: "autoname story",
    description: "ask the model for a story title",
    section: "story",
    available: onStoryPage,
    run: (context) => void context.actions.notes.autoname()
  },
  {
    id: "export",
    title: "export markdown",
    description: "download the current line as a Markdown file",
    section: "story",
    available: onStoryPage,
    run: (context) => void context.actions.notes.exportMarkdown()
  }
]);
