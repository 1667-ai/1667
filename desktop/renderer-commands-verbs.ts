/** Every verb in the app that the manuscript's own commands
 * (`renderer-commands.ts`) do not already cover: destinations, project
 * verbs, Facts, Chapters, line tools, part tools, Aside, and the desktop's
 * own verbs (theme, directions, keys, palette, save). Merged into the one
 * registry so the palette lists every verb exactly once. */
import type { DesktopCommand, DesktopCommandContext } from "./renderer-commands.js";

const hasStory = (ctx: DesktopCommandContext): boolean => ctx.story !== null;
const hasFocus = (ctx: DesktopCommandContext): boolean => ctx.focused !== null;
const always = (): boolean => true;

const STORY_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "story.create", group: "Story", label: "Create story", available: always,
    run: (ctx) => ctx.actions.createStory()
  },
  {
    id: "story.rename", group: "Story", label: "Rename story", available: hasStory,
    run: (ctx) => ctx.actions.renameStory()
  },
  {
    id: "story.autoname", group: "Story", label: "Autoname story", available: hasStory,
    run: (ctx) => ctx.actions.autonameStory()
  },
  {
    id: "story.export-markdown", group: "Story", label: "Export Markdown", available: hasStory,
    run: (ctx) => ctx.actions.exportMarkdown()
  },
  {
    id: "story.import-markdown", group: "Story", label: "Import Markdown, NovelAI, or SillyTavern", available: hasStory,
    run: (ctx) => ctx.actions.importMarkdown()
  },
  {
    id: "story.import-card", group: "Story", label: "Import character card", available: hasStory,
    run: (ctx) => ctx.actions.importCard()
  },
  {
    id: "story.import-lorebook", group: "Story", label: "Import lorebook", available: hasStory,
    run: (ctx) => ctx.actions.importLorebook()
  },
  {
    id: "story.delete", group: "Story", label: "Delete story", available: hasStory,
    run: (ctx) => ctx.actions.deleteStory()
  },
  {
    id: "story.open-authors-note", group: "Story", label: "Edit Author's Note", binding: "navAuthorsNote",
    available: hasStory, handles: { mode: "NAV", action: "open-authors-note" },
    run: (ctx) => {
      if (ctx.state.inspectorHidden) ctx.actions.setInspectorHidden(false);
      ctx.focusInspectorSection("authors-note");
      document.querySelector<HTMLTextAreaElement>('[data-preserve="authors-note"]')?.focus();
    }
  }
];

const TAKE_VERB_COMMANDS: readonly DesktopCommand[] = [
  { id: "take.rewrite", group: "Take", label: "Rewrite this part", available: hasFocus, run: (ctx) => ctx.actions.rewriteLine(ctx.focused!, ctx.selection) },
  { id: "take.take-from-cut", group: "Take", label: "Take from cut", available: hasFocus, run: (ctx) => ctx.actions.takeFromCut(ctx.focused!, ctx.selection) },
  { id: "take.fact-from-selection", group: "Take", label: "Fact from selection", available: (ctx) => hasFocus(ctx) && ctx.selection !== undefined, run: (ctx) => ctx.actions.createFact(ctx.focused!, ctx.selection) },
  { id: "take.new-fact-here", group: "Take", label: "New Fact here", available: hasFocus, run: (ctx) => ctx.actions.createFact(ctx.focused!) },
  {
    id: "take.inspect-part", group: "Take", label: "Inspect this part", available: hasFocus,
    run: (ctx) => {
      const id = ctx.focused!.id;
      ctx.actions.setTab("inspect");
      queueMicrotask(() => document.querySelector<HTMLElement>(`[data-preserve="inspect:${id}"]`)?.scrollIntoView({ block: "nearest" }));
    }
  },
  { id: "take.copy-line-below", group: "Take", label: "Copy line below", available: hasFocus, run: (ctx) => ctx.actions.copyLine(ctx.focused!) },
  {
    id: "take.paste-below", group: "Take", label: "Paste below", available: (ctx) => hasFocus(ctx) && ctx.state.lineClipboard !== null,
    run: (ctx) => ctx.actions.pasteLine(ctx.focused!)
  },
  { id: "take.switch-line-here", group: "Take", label: "Switch line here", available: hasFocus, run: (ctx) => ctx.actions.switchLine(ctx.focused!) },
  { id: "take.edit-direction", group: "Take", label: "Edit direction", available: hasFocus, run: (ctx) => ctx.actions.editNodeDirection(ctx.focused!) },
  {
    id: "take.save-as-take", group: "Take", label: "Save as take", available: hasFocus,
    run: (ctx) => ctx.actions.saveEditedTake(ctx.focused!, ctx.state.drafts[`part:${ctx.focused!.id}`] ?? ctx.focused!.text)
  },
  {
    id: "take.remove-tag", group: "Take", label: "Remove line tag", available: hasFocus,
    run: (ctx) => ctx.actions.removeTag(ctx.focused!)
  },
  { id: "take.summary-take", group: "Take", label: "Summary take", available: hasStory, run: (ctx) => ctx.actions.summarizeLine() },
  { id: "take.prune-unused", group: "Take", label: "Prune unused takes", available: hasStory, run: (ctx) => ctx.actions.pruneUnused() },
  { id: "story.manage-tags", group: "Story", label: "Manage tags", available: hasStory, run: (ctx) => ctx.actions.manageTags() },
  { id: "story.phrase-bias", group: "Story", label: "Phrase bias", available: hasStory, run: (ctx) => ctx.actions.editPhraseBias() },
  { id: "story.banned-strings", group: "Story", label: "Banned strings", available: hasStory, run: (ctx) => ctx.actions.editBannedStrings() },
  {
    id: "take.aside-stop", group: "Take", label: "Stop Aside", available: (ctx) => ctx.state.aside.busy,
    run: (ctx) => ctx.actions.stopAside()
  },
  {
    id: "take.aside-use", group: "Take", label: "Use Aside answer as a line", available: (ctx) => ctx.state.aside.answer.trim().length > 0,
    run: (ctx) => ctx.actions.useAsideAnswer()
  }
];

const FACTS_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "facts.open", group: "Facts", label: "Open Facts", binding: "navOpenFacts",
    available: always, handles: { mode: "NAV", action: "open-facts" },
    run: (ctx) => ctx.actions.setTab("facts")
  },
  { id: "facts.new", group: "Facts", label: "New Fact", available: hasStory, run: (ctx) => ctx.actions.createFact() },
  { id: "facts.check-chapter", group: "Facts", label: "Check chapter", available: hasStory, run: (ctx) => ctx.actions.runFactConsistency("chapter") },
  { id: "facts.check-line", group: "Facts", label: "Check line", available: hasStory, run: (ctx) => ctx.actions.runFactConsistency("story-line") }
];

const CHAPTERS_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "chapters.open", group: "Chapters", label: "Open Chapters", binding: "navOpenChapters",
    available: always, handles: { mode: "NAV", action: "open-chapters" },
    run: (ctx) => ctx.actions.setTab("chapters")
  },
  {
    id: "chapters.new", group: "Chapters", label: "New chapter", binding: "navCreateChapter",
    available: hasFocus, handles: { mode: "NAV", action: "create-chapter" },
    run: (ctx) => ctx.actions.createChapter(ctx.focused!.id)
  },
  {
    id: "chapters.restore-removed", group: "Chapters", label: "Restore removed chapter", binding: "navUndo",
    available: always, handles: { mode: "NAV", action: "undo" },
    run: (ctx) => ctx.state.chapterUndo !== null
      ? ctx.actions.restoreChapter()
      : ctx.toast("Nothing to undo · u reaches an added or removed chapter break")
  }
];

const MAP_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "map.open", group: "Map", label: "Open Map", binding: "navOpenMap",
    available: always, handles: { mode: "NAV", action: "open-map" },
    run: (ctx) => ctx.actions.setTab("map")
  },
  {
    // No key binding: the TUI has no compare key.
    id: "map.compare-cursor-take", group: "Map", label: "Compare the map cursor's take with your line",
    available: (ctx) => ctx.story !== null && ctx.state.mapCursorId !== null
      && !ctx.story.path.some((node) => node.id === ctx.state.mapCursorId),
    run: (ctx) => ctx.actions.compareTake(ctx.state.mapCursorId!)
  }
];

const PROJECT_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "project.open-library", group: "Project", label: "Open Library", binding: "navOpenLibrary",
    available: always, handles: { mode: "NAV", action: "open-library" },
    run: (ctx) => ctx.actions.setTab("library")
  },
  {
    id: "project.open-search", group: "Project", label: "Search the story", binding: "navOpenSearch",
    available: always, handles: { mode: "NAV", action: "open-search" },
    run: (ctx) => {
      ctx.actions.setTab("library");
      document.querySelector<HTMLInputElement>(".library-search")?.focus();
    }
  },
  { id: "project.reveal", group: "Project", label: "Reveal project in Finder", available: always, run: (ctx) => ctx.actions.revealProject() },
  { id: "project.browse", group: "Project", label: "Switch project", available: always, run: (ctx) => ctx.actions.showProjects(true) },
  { id: "project.seal", group: "Project", label: "Seal project", available: always, run: (ctx) => ctx.actions.sealProject() },
  { id: "project.unseal", group: "Project", label: "Unseal project", available: always, run: (ctx) => ctx.actions.unsealProject() },
  { id: "project.refresh", group: "Project", label: "Refresh library", available: always, run: (ctx) => ctx.actions.refresh() }
];

const DESKTOP_COMMANDS: readonly DesktopCommand[] = [
  {
    id: "desktop.open-settings", group: "Desktop", label: "Open Settings", binding: "navOpenSettings", chord: "⌘,",
    available: always, handles: { mode: "NAV", action: "open-settings" },
    run: (ctx) => ctx.actions.setTab("settings")
  },
  { id: "desktop.open-write", group: "Desktop", label: "Open Write", available: hasStory, run: (ctx) => ctx.actions.setTab("write") },
  { id: "desktop.open-inspect", group: "Desktop", label: "Open Inspect", available: hasStory, run: (ctx) => ctx.actions.setTab("inspect") },
  {
    id: "desktop.open-palette", group: "Desktop", label: "Open command palette", binding: "navOpenCommandsColon",
    available: always, handles: { mode: "NAV", action: "open-commands" },
    run: (ctx) => ctx.actions.openPalette()
  },
  {
    id: "desktop.open-keys", group: "Desktop", label: "Show keyboard shortcuts", binding: "navOpenKeysQuestion",
    available: always, handles: { mode: "NAV", action: "open-keys" },
    run: (ctx) => ctx.actions.openKeys()
  },
  {
    id: "desktop.open-log", group: "Desktop", label: "Log", binding: "navOpenLog",
    available: always, handles: { mode: "NAV", action: "open-log" },
    run: (ctx) => ctx.actions.openLog()
  },
  {
    id: "map.open-log", group: "Desktop", label: "Log", binding: "mapOpenLog", hideFromPalette: true,
    available: always, handles: { mode: "MAP", action: "open-log" },
    run: (ctx) => ctx.actions.openLog()
  },
  {
    id: "desktop.toggle-directions", group: "Desktop", label: "Toggle directions", binding: "navToggleInstructions",
    available: hasStory, handles: { mode: "NAV", action: "toggle-instructions" },
    run: (ctx) => ctx.actions.setDirections(!ctx.state.showDirections)
  },
  {
    id: "desktop.toggle-inspector", group: "Desktop", label: "Toggle the inspector", binding: "navToggleRail",
    available: always, handles: { mode: "NAV", action: "toggle-rail" },
    run: (ctx) => ctx.actions.setInspectorHidden(!ctx.state.inspectorHidden)
  },
  {
    id: "desktop.switch-theme", group: "Desktop", label: "Switch theme", available: always,
    run: (ctx) => {
      ctx.actions.setTab("settings");
      ctx.actions.setSettingsSection("desktop");
      document.querySelector<HTMLButtonElement>(".theme-swatch")?.focus();
    }
  },
  {
    id: "desktop.save", group: "Desktop", label: "Save the current edit", chord: "⌘S", available: always,
    run: (ctx) => ctx.actions.saveCurrentEdit()
  }
];

export const VERB_COMMANDS: readonly DesktopCommand[] = [
  ...STORY_COMMANDS,
  ...TAKE_VERB_COMMANDS,
  ...FACTS_COMMANDS,
  ...CHAPTERS_COMMANDS,
  ...MAP_COMMANDS,
  ...PROJECT_COMMANDS,
  ...DESKTOP_COMMANDS
];
