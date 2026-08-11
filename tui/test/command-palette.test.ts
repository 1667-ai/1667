import { describe, expect, test } from "bun:test";
import { THEME_NAMES } from "../src/config.js";
import {
  commandContext,
  commandMatches,
  commandPaletteModel,
  commandPaletteWindow,
  retainCommandSelection,
  type CommandSelectionId
} from "../src/command-model.js";
import { demoAppSource } from "../src/demo.js";
import { hitAt, type HitRows } from "../src/hit.js";
import { panelHorizontalGeometry } from "../src/screens/overlay.js";
import { renderPanels } from "../src/screens/panels.js";
import { plainLine, visibleWidth, type FrameLine } from "../src/screens/story/frame.js";
import { nextRequestEstimate } from "../src/request-projection.js";

describe("grouped command palette model", () => {
  test("builds five sections and one canonical selectable/render order", () => {
    const model = commandPaletteModel("", false);
    expect(model.sections.map((section) => section.label)).toEqual([
      "Suggested", "Story", "Take", "View", "System"
    ]);
    const ids = model.selectable.map((match) => match.command.id);
    for (const id of [
      "summary", "tag-line", "export", "switch-story", "rename-story", "folder",
      "direct-take", "retake", "prune", "autoname", "settings",
      "reconnect"
    ] as const) expect(ids).toContain(id);
    expect(commandMatches("", false)).toEqual(model.selectable);
    expect(model.renderRows.filter((row) => row.kind === "command").map((row) => row.selectableIndex))
      .toEqual(model.selectable.map((_, index) => index));
    for (const [index, row] of model.renderRows.entries()) {
      expect(model.renderRowToSelectable[index]).toBe(row.kind === "section" ? null : row.selectableIndex);
    }
  });

  test("attach image is available once image input's entry points are open, this release's default", () => {
    // shared/image-input-release.ts: this release activates the feature, so
    // the release-wide switch opens every entry point together, including
    // this command's palette availability.
    const model = commandPaletteModel("", false);
    expect(model.selectable.some((match) => match.command.id === "attach-image")).toBeTrue();
  });

  test("filters across descriptions without losing group or theme commands", () => {
    const folder = commandPaletteModel("1667 disk", false);
    expect(folder.sections.map((section) => section.label)).toEqual(["Story"]);
    expect(folder.selectable.map((match) => match.command.id)).toEqual(["folder"]);

    const model = commandPaletteModel("", false);
    expect(model.selectable.filter((match) => match.command.id === "theme")).toHaveLength(THEME_NAMES.length);
    expect(model.selectable.some((match) => match.command.id === "disconnect")).toBeFalse();
    expect(commandPaletteModel("", true).selectable.some((match) => match.command.id === "disconnect")).toBeTrue();
    expect(commandPaletteModel("generation settings", false).selectable.map((match) => match.command.id))
      .toEqual(["settings"]);
  });

  test("Suggested reacts to recovery, request ownership, prose, and an existing line tag", () => {
    const source = demoAppSource();
    const ready = commandContext(source.payload, { connectionDown: false, requestActive: false, canRewriteSelection: false });
    expect(ready.lineTagged).toBeTrue();
    expect(commandPaletteModel("", false, ready).sections[0]!.matches.map((match) => match.command.id))
      .toEqual(["summary", "export"]);

    const active = commandPaletteModel("", false, { ...ready, requestActive: true });
    expect(active.sections[0]!.matches.map((match) => match.command.id)).toEqual(["export"]);
    expect(active.sections.find((section) => section.id === "take")?.matches.some((match) =>
      match.command.id === "summary")).toBeTrue();
    expect(active.sections.find((section) => section.id === "view")?.matches.some((match) =>
      match.command.id === "tag-line")).toBeTrue();

    const offline = commandPaletteModel("", false, { ...ready, connectionDown: true });
    expect(offline.sections[0]!.matches.map((match) => match.command.id)).toEqual(["reconnect", "export"]);
    expect(offline.sections.find((section) => section.id === "system")?.matches.some((match) =>
      match.command.id === "reconnect")).toBeFalse();
    expect(commandPaletteModel("", false, {
      ...ready, connectionDown: true, requestActive: true
    }).sections[0]!.matches.map((match) => match.command.id)).toEqual(["export"]);

    const empty = commandPaletteModel("", false, {
      connectionDown: false, requestActive: false, hasProse: false, lineTagged: false, canRewriteSelection: false
    });
    expect(empty.sections[0]!.matches.map((match) => match.command.id)).toEqual(["export"]);
  });

  test("rename story declares mutation ownership", () => {
    const rename = commandMatches("rename story", false)
      .find(({ command }) => command.id === "rename-story")?.command;
    expect(rename?.mutating).toBeTrue();
    const card = commandMatches("import character card", false)
      .find(({ command }) => command.id === "import-card")?.command;
    expect(card).toMatchObject({
      section: "story",
      name: "import character card",
      description: "add a card's fields as Facts",
      mutating: true
    });
    const archive = commandMatches("import archive", false)
      .find(({ command }) => command.id === "import-archive")?.command;
    expect(archive).toMatchObject({
      section: "story",
      name: "import archive",
      description: "read a NovelAI lorebook, scenario, or story file",
      mutating: true
    });
  });

  test("Author's Note is a Story command with the NAV shortcut", () => {
    const note = commandMatches("author's note", false)
      .find(({ command }) => command.id === "authors-note")?.command;
    expect(note).toMatchObject({
      section: "story",
      shortcut: "a",
      mutating: true
    });
  });

  test("Author Brief is a Story command with no NAV shortcut", () => {
    const brief = commandMatches("author brief", false)
      .find(({ command }) => command.id === "author-brief")?.command;
    expect(brief).toMatchObject({
      section: "story",
      mutating: true
    });
    expect(brief?.shortcut).toBe(undefined);
  });

  test("retains command identity across live Suggested reordering", () => {
    const source = demoAppSource();
    const context = commandContext(source.payload, { connectionDown: false, requestActive: true, canRewriteSelection: false });
    const active = commandPaletteModel("", false, context);
    const cursor = active.selectable.findIndex(({ command }) => command.id === "switch-story");
    const settled = commandPaletteModel("", false, { ...context, requestActive: false });

    const retained = retainCommandSelection(settled.selectable, "switch-story", cursor);

    expect(settled.selectable[retained.cursor]?.command.id).toBe("switch-story");
    expect(retained.selectedId).toBe("switch-story");
  });

  test("compact windows retain the selected command and its section header when possible", () => {
    const model = commandPaletteModel("", false);
    const cursor = model.selectable.length - 1;
    const rows = commandPaletteWindow(model, cursor, 10);
    expect(rows.some((row) => row.kind === "section" && row.section.label === "System")).toBeTrue();
    expect(rows.some((row) => row.selectableIndex === cursor)).toBeTrue();
    expect(rows.every((row) => row.kind !== "section" || row.selectableIndex === null)).toBeTrue();
  });
});

describe("grouped command palette rendering", () => {
  test("renders non-selectable headers, a solid Search cursor, aligned hints, and a full-width selection", () => {
    const { lines, hits } = renderCommands(120, 36, 0);
    const searchRow = lines.find((line) => plainLine(line).includes("Search"))!;
    expect(searchRow.some((segment) => segment.text === " " && segment.background === "focus / accent")).toBeTrue();

    const headerRow = lines.findIndex((line) => plainLine(line).includes("Suggested"));
    const selectedRow = lines.findIndex((line) => plainLine(line).includes("summary take"));
    const tagRow = lines.findIndex((line) => plainLine(line).includes("tag this line"));
    expect(hitAt(hits, 30, headerRow)).toEqual({ kind: "panel" });
    expect(hitAt(hits, 30, selectedRow)).toEqual({ kind: "list", index: 0, selected: true });
    const selectedWidth = lines[selectedRow]!
      .filter((segment) => segment.background === "focus / accent")
      .reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
    const horizontal = panelHorizontalGeometry(120, 72);
    expect(selectedWidth).toBe(horizontal.contentWidth);

    // Measure the content band, not the whole panel: the frame's closing edge
    // sits outside it.
    const panelText = plainLine(lines[tagRow]!)
      .slice(horizontal.contentLeft, horizontal.contentLeft + horizontal.contentWidth);
    expect(panelText.trimEnd().endsWith("t")).toBeTrue();
  });

  test("keeps the selected System command visible at 80×24", () => {
    const model = commandPaletteModel("", false);
    const cursor = model.selectable.length - 1;
    const selectedName = model.selectable[cursor]!.command.name;
    const { lines } = renderCommands(80, 24, cursor);
    expect(lines.map(plainLine).join("\n")).toContain("System");
    expect(lines.map(plainLine).join("\n")).toContain(selectedName);
  });

  test("paints and hits the retained command identity after Suggested reorders", () => {
    const source = demoAppSource();
    const context = commandContext(source.payload, { connectionDown: false, requestActive: true, canRewriteSelection: false });
    const active = commandPaletteModel("", false, context);
    const staleCursor = active.selectable.findIndex(({ command }) => command.id === "switch-story");
    const settled = commandPaletteModel("", false, { ...context, requestActive: false });
    const retainedCursor = settled.selectable.findIndex(({ command }) => command.id === "switch-story");
    expect(staleCursor).not.toBe(retainedCursor);

    const { lines, hits } = renderCommands(120, 36, staleCursor, "switch-story");
    const selectedRow = lines.findIndex((line) => plainLine(line).includes("switch story"));
    const selectedWidth = lines[selectedRow]!
      .filter((segment) => segment.background === "focus / accent")
      .reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
    expect(selectedWidth).toBe(panelHorizontalGeometry(120, 72).contentWidth);
    expect(hitAt(hits, 30, selectedRow)).toEqual({ kind: "list", index: retainedCursor, selected: true });
  });
});

function renderCommands(
  width: number,
  height: number,
  cursor: number,
  selectedId: CommandSelectionId | null = null
): { lines: FrameLine[]; hits: HitRows } {
  const source = demoAppSource();
  const hits: HitRows = Array.from({ length: height }, () => null);
  const base: FrameLine[] = Array.from({ length: height }, (): FrameLine => []);
  const state = {
    payload: source.payload,
    mode: "COMMANDS" as const,
    tag: null,
    focusIndex: source.payload.path.length - 1,
    now: 1_667_000_000_000,
    contextWindow: source.settings.contextWindow,
    stream: null,
    abort: null,
    actions: null,
    textActions: null,
    config: source.config,
    readingPositions: source.readingPositions,
    demo: false,
    storyFolder: source.storyFolder,
    library: null,
    facts: null,
    commands: {
      query: "", cursor, selectedId, view: "commands" as const, returnMode: "NAV" as const
    },
    card: null,
    archive: null,
    chapters: null,
    settings: null,
    summary: null,
    connection: { down: false, attempt: 0, nextRetryAt: null, error: null }
  };
  const request = {
    systemPrompt: source.settings.systemPrompt,
    instruction: "",
    operation: "continue" as const,
    targetId: source.payload.path.at(-1)?.id ?? null,
    assistantPrefill: true,
    contextWindow: source.settings.contextWindow,
    maxTokens: source.settings.maxTokens
  };
  const estimate = nextRequestEstimate(source.payload, request);
  return { lines: renderPanels(base, state, hits, width, height, estimate).lines, hits };
}
