import type { StoryPayload } from "../../shared/types.js";
import { THEME_NAMES, type ThemeName } from "./config.js";
import { fuzzyMatch } from "./fuzzy.js";

export type CommandSectionId = "suggested" | "story" | "take" | "view" | "system";
export type CommandId =
  | "export" | "summary" | "tag-line"
  | "switch-story" | "rename-story" | "folder" | "autoname" | "import-card" | "import-archive"
  | "authors-note" | "author-brief" | "facts-budget" | "phrase-bias" | "banned-strings"
  | "direct-take" | "retake" | "rewrite-selection" | "prune"
  | "tags" | "chapters" | "chapter" | "prompts"
  | "next-request" | "token-probabilities"
  | "settings" | "reconnect" | "disconnect" | "theme";

export type CommandSelectionId = Exclude<CommandId, "theme"> | `theme:${ThemeName}`;

export interface PaletteCommand {
  id: CommandId;
  section: CommandSectionId;
  name: string;
  description: string;
  /** Existing NAV key, shown right-aligned so this list is also a reference. */
  shortcut?: string;
  demoOnly?: boolean;
  mutating?: boolean;
  theme?: ThemeName;
  /** Extra live gate beyond demo/mutating, e.g. rewrite-selection needing a
   *  selection this build can actually rewrite. Absent means always allowed. */
  requires?: (context: CommandPaletteContext) => boolean;
}

export interface CommandMatch {
  command: PaletteCommand;
  indices: number[];
  score: number;
}

export interface CommandPaletteSection {
  id: CommandSectionId;
  label: string;
  matches: CommandMatch[];
}

export type CommandPaletteRenderRow =
  | { kind: "section"; section: CommandPaletteSection; selectableIndex: null }
  | { kind: "command"; match: CommandMatch; selectableIndex: number };

export interface CommandPaletteModel {
  sections: CommandPaletteSection[];
  /** Canonical cursor order. The reducer's commandMatches() returns this array. */
  selectable: CommandMatch[];
  /** Headers and commands in paint order. Headers deliberately map to null. */
  renderRows: CommandPaletteRenderRow[];
  renderRowToSelectable: Array<number | null>;
}

export interface CommandPaletteContext {
  connectionDown: boolean;
  requestActive: boolean;
  hasProse: boolean;
  lineTagged: boolean;
  /** A captured selection this build can actually rewrite — not merely
   *  "some selection exists" (see `canRewriteSelection` in
   *  selection-projection.ts). */
  canRewriteSelection: boolean;
}

const DEFAULT_CONTEXT: CommandPaletteContext = {
  connectionDown: false,
  requestActive: false,
  hasProse: true,
  lineTagged: false,
  canRewriteSelection: false
};

const SECTIONS: ReadonlyArray<{ id: CommandSectionId; label: string }> = [
  { id: "suggested", label: "Suggested" },
  { id: "story", label: "Story" },
  { id: "take", label: "Take" },
  { id: "view", label: "View" },
  { id: "system", label: "System" }
];

const COMMANDS: readonly PaletteCommand[] = [
  { id: "summary", section: "take", name: "summary take", description: "compress the current prefix into continuity", mutating: true },
  { id: "tag-line", section: "view", name: "tag this line", description: "remember this leaf and its current path", shortcut: "t", mutating: true },
  { id: "export", section: "story", name: "export markdown", description: "write the current line beside your terminal" },

  { id: "switch-story", section: "story", name: "switch story", description: "open another story from the library", shortcut: "o" },
  { id: "rename-story", section: "story", name: "rename story", description: "change the current story title", mutating: true },
  { id: "folder", section: "story", name: "open story folder", description: "reveal the .1667 directory on disk" },
  { id: "autoname", section: "story", name: "autoname story", description: "ask the model for a story title", mutating: true },
  { id: "import-archive", section: "story", name: "import archive", description: "read a NovelAI lorebook, scenario, or story file", mutating: true },
  { id: "import-card", section: "story", name: "import character card", description: "add a card's fields as Facts", mutating: true },
  { id: "authors-note", section: "story", name: "author's note", description: "steer the next passage with style, tone, or current truth", shortcut: "a", mutating: true },
  { id: "author-brief", section: "story", name: "author brief", description: "override the machine-wide author brief for this story", mutating: true },
  { id: "facts-budget", section: "story", name: "facts budget", description: "cap the combined estimated tokens every Fact spends in a request", mutating: true },
  { id: "phrase-bias", section: "story", name: "phrase bias", description: "bias phrases for this story only, adding to the profile's own", mutating: true },
  { id: "banned-strings", section: "story", name: "banned strings", description: "ban strings for this story only, adding to the profile's own", mutating: true },

  { id: "direct-take", section: "take", name: "direct take", description: "write the next take from an instruction", shortcut: "i" },
  { id: "retake", section: "take", name: "retake", description: "retake the focused part as a sibling", shortcut: "r", mutating: true },
  {
    id: "rewrite-selection", section: "take", name: "rewrite selection",
    description: "regenerate the highlighted text", mutating: true,
    requires: (context) => context.canRewriteSelection
  },
  { id: "prune", section: "take", name: "prune drafts & discarded", description: "review unused leaf takes before removal", shortcut: "d", mutating: true },

  { id: "tags", section: "view", name: "tag manager", description: "inspect or delete remembered leaves" },
  { id: "chapters", section: "view", name: "chapters", description: "open the chapter table and context meter", shortcut: "c" },
  { id: "chapter", section: "view", name: "chapter: end here", description: "end the current chapter after this leaf", shortcut: "C", mutating: true },
  { id: "prompts", section: "view", name: "toggle directions", description: "show or hide directions above each part", shortcut: "p" },
  { id: "next-request", section: "view", name: "next request", description: "inspect the exact next model request", shortcut: "⌃r" },
  {
    id: "token-probabilities", section: "view", name: "token probabilities", shortcut: "l",
    description: "the alternative tokens the model weighed for this take",
    requires: (context) => context.hasProse
  },

  { id: "settings", section: "system", name: "generation settings", description: "inspect and edit provider, model, and context", shortcut: "," },
  { id: "reconnect", section: "system", name: "reconnect", description: "reload this story and its library", shortcut: "R" },
  ...THEME_NAMES.map((theme): PaletteCommand => ({
    id: "theme", section: "system", theme, name: `theme: ${theme}`,
    description: "switch the palette · persists per user"
  })),
  { id: "disconnect", section: "system", name: "simulate disconnect", description: "demo-only connection banner fixture", demoOnly: true }
];

export function commandContext(
  payload: StoryPayload,
  context: { connectionDown: boolean; requestActive: boolean; canRewriteSelection: boolean }
): CommandPaletteContext {
  const leafId = payload.path.at(-1)?.id ?? null;
  return {
    connectionDown: context.connectionDown,
    requestActive: context.requestActive,
    hasProse: payload.path.length > 0,
    lineTagged: leafId !== null && payload.tags.some((tag) => tag.nodeId === leafId),
    canRewriteSelection: context.canRewriteSelection
  };
}

/** Build grouped rows and cursor order together, preventing header/cursor drift. */
export function commandPaletteModel(
  query: string,
  demo: boolean,
  context: CommandPaletteContext = DEFAULT_CONTEXT
): CommandPaletteModel {
  const allowed = COMMANDS.filter((command) => (demo || command.demoOnly !== true)
    && (command.requires === undefined || command.requires(context)));
  const candidates = allowed.map(matchCommand).filter((match): match is CommandMatch => match !== null);
  const needle = query.trim().toLocaleLowerCase();
  // A literal label/description hit is intent, not just another fuzzy score.
  // Dropping incidental subsequences keeps `prune` focused on prune instead of
  // surfacing earlier-section prose that happens to contain p-r-u-n-e in order.
  const literal = needle.length === 0 ? candidates : candidates.filter(({ command }) =>
    command.name.toLocaleLowerCase().includes(needle)
    || command.description.toLocaleLowerCase().includes(needle)
    || command.shortcut?.toLocaleLowerCase() === needle);
  const matched = literal.length > 0 ? literal : candidates;
  const sections: CommandPaletteSection[] = [];
  const selectable: CommandMatch[] = [];
  const renderRows: CommandPaletteRenderRow[] = [];
  const suggestions = suggestedCommands(context);

  for (const definition of SECTIONS) {
    const matches = matched
      .filter((match) => commandSection(match.command, suggestions) === definition.id)
      .sort((left, right) => definition.id === "suggested"
        ? suggestions.indexOf(left.command.id) - suggestions.indexOf(right.command.id)
        : left.score - right.score);
    if (matches.length === 0) continue;
    const section: CommandPaletteSection = { ...definition, matches };
    sections.push(section);
    renderRows.push({ kind: "section", section, selectableIndex: null });
    for (const match of matches) {
      const selectableIndex = selectable.length;
      selectable.push(match);
      renderRows.push({ kind: "command", match, selectableIndex });
    }
  }

  return {
    sections,
    selectable,
    renderRows,
    renderRowToSelectable: renderRows.map((row) => row.selectableIndex)
  };

  function matchCommand(command: PaletteCommand): CommandMatch | null {
    const match = fuzzyMatch(`${command.name} ${command.description} ${command.shortcut ?? ""}`, query);
    if (match === null) return null;
    const nameLength = [...command.name].length;
    return {
      command,
      indices: match.indices.filter((index) => index < nameLength),
      score: match.score
    };
  }
}

/** Compatibility surface used by command execution and live theme preview. */
export function commandMatches(
  query: string,
  demo: boolean,
  context: CommandPaletteContext = DEFAULT_CONTEXT
): CommandMatch[] {
  return commandPaletteModel(query, demo, context).selectable;
}

export interface RetainedCommandSelection {
  cursor: number;
  selectedId: CommandSelectionId | null;
}

/** Keep the selected command stable when live context moves rows between sections. */
export function retainCommandSelection(
  matches: readonly CommandMatch[],
  selectedId: CommandSelectionId | null,
  fallbackCursor: number
): RetainedCommandSelection {
  if (matches.length === 0) return { cursor: 0, selectedId: null };
  const retained = selectedId === null
    ? -1
    : matches.findIndex(({ command }) => commandSelectionId(command) === selectedId);
  const cursor = retained >= 0
    ? retained
    : Math.max(0, Math.min(matches.length - 1, fallbackCursor));
  return { cursor, selectedId: commandSelectionId(matches[cursor]!.command) };
}

export function commandSelectionId(command: PaletteCommand): CommandSelectionId {
  return command.id === "theme" ? `theme:${command.theme!}` : command.id;
}

function suggestedCommands(context: CommandPaletteContext): CommandId[] {
  if (context.requestActive) return ["export"];
  if (context.connectionDown) return ["reconnect", "export"];
  return [
    ...(context.hasProse ? ["summary" as const] : []),
    ...(context.hasProse && !context.lineTagged
      ? ["tag-line" as const]
      : []),
    "export"
  ];
}

function commandSection(command: PaletteCommand, suggestions: readonly CommandId[]): CommandSectionId {
  return suggestions.includes(command.id) ? "suggested" : command.section;
}

/** Crop grouped rows around a cursor for compact terminals. */
export function commandPaletteWindow(
  model: CommandPaletteModel,
  cursor: number,
  maxRows: number
): CommandPaletteRenderRow[] {
  if (maxRows <= 0 || model.renderRows.length === 0) return [];
  if (model.renderRows.length <= maxRows) return model.renderRows;
  const selected = Math.max(0, Math.min(model.selectable.length - 1, cursor));
  const selectedRow = model.renderRows.findIndex((row) => row.selectableIndex === selected);
  let start = Math.max(0, Math.min(model.renderRows.length - maxRows, selectedRow - Math.floor(maxRows / 2)));

  // Keep the selected command's section label when that whole group fits.
  let header = selectedRow;
  while (header > 0 && model.renderRows[header]?.kind !== "section") header -= 1;
  if (selectedRow - header < maxRows) start = Math.min(start, header);
  start = Math.min(start, model.renderRows.length - maxRows);
  let rows = model.renderRows.slice(start, start + maxRows);
  // A trailing label with none of its commands is more confusing than whitespace.
  if (rows.at(-1)?.kind === "section") rows = rows.slice(0, -1);
  return rows;
}
