import { focusComposer } from "../compose/dom.js";
import { openMap } from "../app/router.js";
import { pushToast } from "../app/toasts.js";
import { registerCommands, type CommandContext, type PaletteCommand } from "../palette/registry.js";
import type { WebPartActionId } from "./part-policy.js";
import { NOTHING_TO_MAP_TOAST } from "./reading-keys.js";
import { effectiveFocusedPartId } from "./state.js";

/** The focused part when the story's own page (not the map, not the Library) is open and loaded. */
function focusedPart(context: CommandContext): string | null {
  const { route, story } = context.state;
  if (route.kind !== "story" || route.map === true || story.kind !== "loaded" || story.payload.id !== route.id) return null;
  return effectiveFocusedPartId(story);
}

function onStoryPage(context: CommandContext): boolean {
  const { route, story } = context.state;
  return route.kind === "story" && route.map !== true && story.kind === "loaded" && story.payload.id === route.id;
}

/** A command that is one part action on the focused part; the one policy refuses it with a toast. */
function partCommand(
  id: string,
  title: string,
  description: string,
  section: PaletteCommand["section"],
  shortcut: string,
  action: WebPartActionId
): PaletteCommand {
  return {
    id,
    title,
    description,
    section,
    shortcut,
    available: (context) => focusedPart(context) !== null,
    run: (context) => {
      const partId = focusedPart(context);
      if (partId !== null) context.actions.part.run(action, partId);
    }
  };
}

registerCommands([
  {
    id: "direct-take",
    title: "direct take",
    description: "write the next take from an instruction",
    section: "take",
    shortcut: "i",
    available: onStoryPage,
    run: (context) => {
      const partId = focusedPart(context);
      if (partId === null) focusComposer();
      else context.actions.part.run("direct", partId);
    }
  },
  partCommand("retake", "retake", "retake the focused part as a sibling", "take", "r", "retake"),
  partCommand("tag-line", "tag this line", "remember this leaf and its current path", "view", "t", "tag"),
  partCommand("tags", "tag manager", "inspect or delete remembered leaves", "view", "t", "tag"),
  partCommand("chapter", "chapter: end here", "end the current chapter after this leaf", "view", "C", "end-chapter"),
  {
    id: "chapters",
    title: "chapters",
    description: "open the chapter table",
    section: "view",
    shortcut: "c",
    available: onStoryPage,
    run: (context) => context.actions.panel.open("chapters")
  },
  {
    id: "facts",
    title: "facts overview",
    description: "open the Facts manager and inspect story memory",
    section: "view",
    shortcut: "f",
    available: onStoryPage,
    run: (context) => context.actions.panel.open("facts")
  },
  {
    id: "aside",
    title: "aside",
    description: "discuss this story without changing it",
    section: "story",
    shortcut: "a",
    available: onStoryPage,
    run: (context) => context.actions.aside.open()
  },
  {
    id: "map",
    title: "story map",
    description: "see every line and fork of the story",
    section: "view",
    shortcut: "m",
    available: onStoryPage,
    run: (context) => {
      const { story } = context.state;
      if (story.kind !== "loaded") return;
      if (story.payload.nodes.length === 0) pushToast(context.store, NOTHING_TO_MAP_TOAST);
      else openMap(story.payload.id);
    }
  },
  {
    id: "typewriter",
    title: "typewriter mode",
    description: "keep the focused part in the middle of the page",
    section: "view",
    shortcut: "z",
    available: onStoryPage,
    run: (context) => context.actions.story.toggleTypewriter()
  },
  {
    id: "prompts",
    title: "toggle directions",
    description: "show or hide directions above each part",
    section: "view",
    shortcut: "p",
    available: onStoryPage,
    run: (context) => context.actions.story.toggleDirections()
  }
]);
