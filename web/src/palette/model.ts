import { fuzzyMatch } from "../../../shared/fuzzy.js";
import type { CommandContext, CommandSection, PaletteCommand } from "./registry.js";

export interface CommandMatch {
  readonly command: PaletteCommand;
  /** Indices into `command.title` to highlight. */
  readonly indices: readonly number[];
  readonly score: number;
}

export interface CommandGroup {
  readonly id: CommandSection;
  readonly label: string;
  readonly matches: readonly CommandMatch[];
}

const SECTIONS: ReadonlyArray<{ readonly id: CommandSection; readonly label: string }> = [
  { id: "suggested", label: "Suggested" },
  { id: "story", label: "Story" },
  { id: "take", label: "Take" },
  { id: "view", label: "View" },
  { id: "system", label: "System" }
];

/** The commands worth offering first, as `tui/src/command-model.ts`'s
 * `suggestedCommands` does for the commands the web has: a lost connection
 * puts reconnect on top, nothing is suggested while a run owns the story, and
 * otherwise a story with a stored Fact check suggests its findings (or, with
 * Facts and no check yet, checking the chapter), and an untagged line suggests
 * tagging it. */
function suggestedIds(context: CommandContext): readonly string[] {
  const { state } = context;
  if (state.connection.kind === "closed") return ["reconnect"];
  if (state.generation.kind !== "idle") return [];
  if (state.story.kind !== "loaded") return [];
  const { payload } = state.story;
  const leafId = payload.path.at(-1)?.id ?? null;
  const tagged = leafId !== null && payload.tags.some((tag) => tag.nodeId === leafId);
  return [
    ...(payload.hasFactConsistencyRun === true
      ? ["show-fact-findings"]
      : payload.facts.length > 0 ? ["check-chapter-against-facts"] : []),
    ...(leafId !== null && !tagged ? ["tag-line"] : [])
  ];
}

/** Groups the available commands for `query`, in the TUI's order and ranking:
 * a literal hit in a title, description or shortcut beats an incidental
 * fuzzy one, and a group's commands rank by score. */
export function paletteGroups(
  commands: readonly PaletteCommand[],
  query: string,
  context: CommandContext
): CommandGroup[] {
  const candidates: CommandMatch[] = [];
  for (const command of commands) {
    if (command.available !== undefined && !command.available(context)) continue;
    const match = fuzzyMatch([command.title, command.description, command.shortcut ?? ""].join(" "), query);
    if (match === null) continue;
    const titleLength = [...command.title].length;
    candidates.push({ command, indices: match.indices.filter((index) => index < titleLength), score: match.score });
  }
  const needle = query.trim().toLocaleLowerCase();
  const literal = needle.length === 0
    ? candidates
    : candidates.filter(({ command }) => command.title.toLocaleLowerCase().includes(needle)
      || command.description.toLocaleLowerCase().includes(needle)
      || command.shortcut?.toLocaleLowerCase() === needle);
  const matched = literal.length > 0 ? literal : candidates;
  const suggestions = suggestedIds(context);
  const groups: CommandGroup[] = [];
  for (const section of SECTIONS) {
    const matches = matched
      .filter(({ command }) => (suggestions.includes(command.id) ? "suggested" : command.section) === section.id)
      .sort((left, right) => section.id === "suggested"
        ? suggestions.indexOf(left.command.id) - suggestions.indexOf(right.command.id)
        : left.score - right.score);
    if (matches.length > 0) groups.push({ id: section.id, label: section.label, matches });
  }
  return groups;
}
