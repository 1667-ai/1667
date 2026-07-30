import { describe, expect, test } from "bun:test";
import {
  STARTER_LOGO_LINES,
  STARTER_LOGO_TEXT,
  STARTER_STORIES
} from "../../shared/starter-vault.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { dimPage } from "../src/screens/overlay.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { lineWidth, plainLine, type DisplayRole } from "../src/screens/story/frame.js";
import { storyPartWrapPlan } from "../src/screens/story/row-layout.js";
import { syntheticStoryPayload } from "./fixtures/story.js";

const LOGO_ROLES: readonly DisplayRole[] = [
  "logo red", "logo orange", "logo yellow", "logo green",
  "logo cyan", "logo blue", "logo violet"
];

const LOGO_MARKS = [
  "_  __    __ _____",
  "/ |/ /_  / /|___  |",
  "| | '_ \\| '_ \\ / /",
  "| | (_) | (_) / /",
  "|_|\\___/ \\___/_/"
] as const;

describe("starter story logo", () => {
  test("renders a rainbow mark inside the ordinary opening part", () => {
    const payload = syntheticStoryPayload(1, 1, "starter-logo");
    const opening = payload.path[0]!;
    opening.text = `${STARTER_LOGO_TEXT}\n\nWelcome to 1667. Start writing.`;
    payload.nodes[0]!.preview = STARTER_LOGO_LINES[0]!;
    const source = demoAppSource(false);
    source.payload = payload;
    const state = initialState(source, false);

    const frame = renderStoryScreen(state, { width: 120, height: 24 });
    const text = frame.lines.map(plainLine).join("\n");
    const roles = new Set(frame.lines.flat().map((part) => part.role));

    for (const mark of LOGO_MARKS) expect(text).toContain(mark);
    expect(text).toContain("Welcome to 1667. Start writing.");
    expect(text).not.toContain("enter the story");
    expect(text).not.toContain("edit cover");
    for (const role of LOGO_ROLES) expect(roles.has(role)).toBeTrue();
  });

  test("keeps its indentation and color after a prose-only edit", () => {
    const payload = syntheticStoryPayload(1, 1, "edited-starter-logo");
    const opening = payload.path[0]!;
    const edited = `\n${STARTER_LOGO_TEXT}\n\nWelcome to the edited tour. \n`.trim();
    const editStart = edited.indexOf("edited tour");
    opening.text = edited;
    opening.attribution = {
      source: "human",
      ranges: [{ start: editStart, end: editStart + "edited tour".length }]
    };
    const source = demoAppSource(false);
    source.payload = payload;

    const frame = renderStoryScreen(initialState(source, false), { width: 120, height: 24 });
    const roles = new Set(frame.lines.flat().map((part) => part.role));

    expect(edited.startsWith(`${STARTER_LOGO_TEXT}\n\n`)).toBeTrue();
    for (const role of LOGO_ROLES) expect(roles.has(role)).toBeTrue();
    expect(roles.has("human edit")).toBeTrue();
  });

  test("uses a compact rainbow mark at the minimum supported width", () => {
    const payload = syntheticStoryPayload(1, 1, "narrow-starter-logo");
    payload.path[0]!.text = STARTER_STORIES[0]!.beats[0]!.takes[0]!.text;
    const source = demoAppSource(false);
    source.payload = payload;

    const frame = renderStoryScreen(initialState(source, false), { width: 20, height: 24 });
    const text = frame.lines.map(plainLine).join("\n");
    const roles = new Set(frame.lines.flat().map((part) => part.role));

    expect(text).toContain("1667");
    expect(text).not.toContain(LOGO_MARKS[0]);
    expect(Math.max(...frame.lines.map(lineWidth)) <= 20).toBeTrue();
    for (const role of ["logo red", "logo yellow", "logo green", "logo violet"] as const) {
      expect(roles.has(role)).toBeTrue();
    }

    const shortFrame = renderStoryScreen(initialState(source, false), { width: 80, height: 10 });
    expect(shortFrame.lines.map(plainLine).join("\n")).toContain(LOGO_MARKS[0]);
  });

  test("dims the rainbow with story focus and overlays", () => {
    const payload = syntheticStoryPayload(2, 1, "dimmed-starter-logo");
    payload.path[0]!.text = `${STARTER_LOGO_TEXT}\n\nWelcome to 1667.`;
    const source = demoAppSource(false);
    source.payload = payload;
    const focused = initialState(source, false);
    const colorful = renderStoryScreen(focused, { width: 120, height: 24 });

    const overlayRoles = new Set(dimPage(colorful.lines).flat().map((part) => part.role));
    for (const role of LOGO_ROLES) expect(overlayRoles.has(role)).toBeFalse();
    expect(overlayRoles.has("dimmed page")).toBeTrue();

    focused.focusIndex = 1;
    const unfocused = renderStoryScreen(focused, { width: 120, height: 24 });
    const unfocusedRoles = new Set(unfocused.lines.flat().map((part) => part.role));
    for (const role of LOGO_ROLES) expect(unfocusedRoles.has(role)).toBeFalse();
    expect(unfocusedRoles.has("prose · dim")).toBeTrue();
  });

  test("does not apply starter-logo projection to summary prose", () => {
    const text = `${STARTER_LOGO_TEXT}\n\nSummary prose.`;
    const plan = storyPartWrapPlan({
      id: "summary-with-logo",
      node: { text },
      isSummary: true,
      humanSpans: []
    }, null, 18);

    expect(plan.compactLogo).toBeFalse();
    expect(plan.sourceStart).toBe(0);
    expect(plan.text).toBe(text);
  });
});
