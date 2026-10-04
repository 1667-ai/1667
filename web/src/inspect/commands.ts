import { isStoryPage, openStoryPage } from "../app/router.js";
import { registerCommands, type CommandContext } from "../palette/registry.js";
import { effectiveFocusedPartId } from "../story/state.js";

/** The focused part when the story's own page is open and loaded. */
function focusedPart(context: CommandContext): string | null {
  const { route, story } = context.state;
  if (!isStoryPage(route) || story.kind !== "loaded" || story.payload.id !== route.id) return null;
  return effectiveFocusedPartId(story);
}

function onStoryPage(context: CommandContext): boolean {
  const { route, story } = context.state;
  return isStoryPage(route) && story.kind === "loaded" && story.payload.id === route.id;
}

registerCommands([
  {
    id: "next-request",
    title: "next request",
    description: "inspect the exact next model request",
    section: "view",
    shortcut: "⌃r",
    available: onStoryPage,
    run: (context) => {
      const { route } = context.state;
      if (route.kind === "story") openStoryPage(route.id, { kind: "request" });
    }
  },
  {
    id: "token-probabilities",
    title: "token probabilities",
    description: "the alternative tokens the model weighed for this take",
    section: "view",
    shortcut: "l",
    available: (context) => focusedPart(context) !== null,
    run: (context) => {
      const nodeId = focusedPart(context);
      if (nodeId !== null && context.state.route.kind === "story") openStoryPage(context.state.route.id, { kind: "probs", nodeId });
    }
  },
  {
    id: "generation-records",
    title: "generation records",
    description: "every captured request that produced or changed this take",
    section: "view",
    shortcut: "h",
    available: (context) => focusedPart(context) !== null,
    run: (context) => {
      const nodeId = focusedPart(context);
      if (nodeId !== null && context.state.route.kind === "story") openStoryPage(context.state.route.id, { kind: "records", nodeId });
    }
  },
  {
    id: "thought",
    title: "thought",
    description: "show or hide the stored thought of this take",
    section: "view",
    shortcut: "T",
    available: onStoryPage,
    run: (context) => context.actions.thoughts.toggle()
  }
]);

