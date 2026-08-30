import { describe, expect, test } from "bun:test";
import {
  THEME_NAMES,
  normalizeUserConfig,
  type ThemeName
} from "../src/config.js";
import {
  createPalette,
  theme256ContextWarning,
  theme256Index,
  type ColorDepth,
  type PaletteRole
} from "../src/palette.js";
import { renderConnectionBanner } from "../src/screens/connection-banner.js";
import { displayColor, visibleWidth, type DisplayRole } from "../src/screens/story/frame.js";

type CoreRole =
  | "background"
  | "prose"
  | "prose · dim"
  | "chrome"
  | "focus / accent"
  | "streaming"
  | "human edit"
  | "tag · canon"
  | "danger";

const CORE: Record<ThemeName, Record<CoreRole, string>> = {
  lantern: {
    background: "#14100B", prose: "#E9DFC9", "prose · dim": "#9A8A70",
    chrome: "#6E604C", "focus / accent": "#FFB454", streaming: "#FFF2D8",
    "human edit": "#8FB4D9", "tag · canon": "#E3B341", danger: "#E0603F"
  },
  "iron gall": {
    background: "#0D1014", prose: "#D8DEE4", "prose · dim": "#8B96A0",
    chrome: "#4E5A66", "focus / accent": "#A8C0D8", streaming: "#EEF4FA",
    "human edit": "#D9A96C", "tag · canon": "#D4B254", danger: "#E0603F"
  },
  parchment: {
    background: "#F2EAD9", prose: "#2A2016", "prose · dim": "#5C4E36",
    chrome: "#7A6748", "focus / accent": "#9A5A10", streaming: "#0F0A04",
    "human edit": "#2C5578", "tag · canon": "#8A6510", danger: "#A8331A"
  },
  bond: {
    background: "#F4F2ED", prose: "#222426", "prose · dim": "#55585C",
    chrome: "#6C685E", "focus / accent": "#A8321E", streaming: "#0A0C0E",
    "human edit": "#235A8C", "tag · canon": "#7A6010", danger: "#8E1F10"
  },
  graphite: {
    background: "#121215", prose: "#E6E4DE", "prose · dim": "#A9A9B0",
    chrome: "#85858D", "focus / accent": "#D8F55A", streaming: "#F4F3ED",
    "human edit": "#8FB8D9", "tag · canon": "#E4C65A", danger: "#F06755"
  },
  bone: {
    background: "#EDEBE3", prose: "#1C1B18", "prose · dim": "#4A473F",
    chrome: "#6B675C", "focus / accent": "#B52D14", streaming: "#141310",
    "human edit": "#245F8E", "tag · canon": "#8C6500", danger: "#760000"
  },
  "hi-contrast dark": {
    background: "#000000", prose: "#FFFFFF", "prose · dim": "#C4C4C4",
    chrome: "#9A9A9A", "focus / accent": "#FFC400", streaming: "#FFFFFF",
    "human edit": "#6FB8FF", "tag · canon": "#FFD84D", danger: "#FF5A45"
  },
  "hi-contrast light": {
    background: "#FFFFFF", prose: "#000000", "prose · dim": "#333333",
    chrome: "#4A4A4A", "focus / accent": "#9A3800", streaming: "#000000",
    "human edit": "#144E86", "tag · canon": "#6A4A00", danger: "#A00000"
  }
};

const ALL_ROLES: readonly PaletteRole[] = [
  "background", "raised", "chrome", "prose", "prose · dim",
  "focus / accent", "accent · deep", "compose accent", "streaming", "human edit",
  "summary", "tag · canon", "tag · alt", "tag · draft",
  "tag · discarded", "danger", "dimmed page"
];

function hex(theme: ThemeName, role: PaletteRole): string {
  const color = createPalette(theme, "truecolor").color(role);
  if (typeof color !== "string") throw new TypeError(`${theme}/${role} did not resolve to truecolor`);
  return color;
}

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/../g)?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new TypeError(`invalid color ${color}`);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function hue(color: string): number {
  const [red, green, blue] = color.slice(1).match(/../g)!
    .map((channel) => Number.parseInt(channel, 16) / 255);
  const maximum = Math.max(red!, green!, blue!);
  const minimum = Math.min(red!, green!, blue!);
  const range = maximum - minimum;
  if (range === 0) throw new TypeError(`logo color has no hue: ${color}`);
  const sector = maximum === red
    ? ((green! - blue!) / range) % 6
    : maximum === green
      ? (blue! - red!) / range + 2
      : (red! - green!) / range + 4;
  return (sector * 60 + 360) % 360;
}

function xtermHex(index: number): string {
  if (index < 16) {
    const system = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#C0C0C0",
      "#808080", "#FF0000", "#00FF00", "#FFFF00", "#0000FF", "#FF00FF", "#00FFFF", "#FFFFFF"
    ];
    return system[index]!;
  }
  if (index >= 232) {
    const channel = 8 + ((index - 232) * 10);
    const value = channel.toString(16).padStart(2, "0").toUpperCase();
    return `#${value}${value}${value}`;
  }
  const levels = [0, 95, 135, 175, 215, 255];
  const cube = index - 16;
  const channels = [
    levels[Math.floor(cube / 36)]!,
    levels[Math.floor(cube / 6) % 6]!,
    levels[cube % 6]!
  ];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** The four slices the request meter paints (doc 12b). Their colors are
 * whatever `frame.ts` resolves them to, which is the point: this reads the
 * shipped assignment rather than restating it. */
const BREAKDOWN_ROLES: readonly DisplayRole[] =
  ["context voice", "context facts", "context recent", "context summary"];

const LOGO_ROLES: readonly DisplayRole[] = [
  "logo red", "logo orange", "logo yellow", "logo green",
  "logo cyan", "logo blue", "logo violet"
];

/** A display role's shipped color at either depth, as hex. */
function displayHex(theme: ThemeName, depth: ColorDepth, role: DisplayRole): string {
  const color = displayColor(role, createPalette(theme, depth));
  if (typeof color === "string") return color.toUpperCase();
  const [red, green, blue] = color.toInts();
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

describe("theme palette", () => {
  test("ships all eight themes in settings order", () => {
    expect(THEME_NAMES).toEqual([
      "lantern", "iron gall", "parchment", "bond", "graphite", "bone",
      "hi-contrast dark", "hi-contrast light"
    ]);
  });

  test("pins the design spec core colors", () => {
    for (const theme of THEME_NAMES) {
      for (const [role, expected] of Object.entries(CORE[theme])) {
        expect(hex(theme, role as CoreRole)).toBe(expected);
      }
    }
  });

  test("defines every secondary role and keeps compose accent semantic", () => {
    for (const theme of THEME_NAMES) {
      for (const role of ALL_ROLES) expect(hex(theme, role)).toMatch(/^#[0-9A-F]{6}$/);
      expect(hex(theme, "compose accent")).toBe(hex(theme, "human edit"));
    }
  });

  test("bolds fresh ink only on light-theme polarity", () => {
    expect(THEME_NAMES.map((theme) => createPalette(theme, "truecolor").freshBold))
      .toEqual([false, false, true, true, false, true, false, true]);
  });

  test("corrected light text clears 4.5:1 and high-contrast chrome clears 7:1", () => {
    for (const theme of ["parchment", "bond", "bone"] as const) {
      const background = hex(theme, "background");
      for (const role of ["prose", "prose · dim", "chrome"] as const) {
        expect(contrast(background, hex(theme, role))).toBeGreaterThan(4.499);
      }
    }
    for (const theme of ["hi-contrast dark", "hi-contrast light"] as const) {
      expect(contrast(hex(theme, "background"), hex(theme, "chrome"))).toBeGreaterThan(6.999);
    }
  });

  test("pins a distinct 256-color table for every theme", () => {
    expect(ALL_ROLES.map((role) => theme256Index("lantern", role))).toEqual([
      233, 234, 241, 187, 101, 215, 179, 110, 230, 110, 180, 178, 139, 109, 243, 166, 240
    ]);
    expect(ALL_ROLES.map((role) => theme256Index("graphite", role))).toEqual([
      233, 234, 245, 253, 248, 191, 149, 110, 231, 110, 246, 185, 183, 116, 243, 203, 240
    ]);
    expect(ALL_ROLES.map((role) => theme256Index("bone", role))).toEqual([
      255, 254, 241, 234, 238, 124, 88, 24, 16, 24, 95, 94, 96, 23, 244, 52, 245
    ]);
    for (const theme of THEME_NAMES) {
      for (const role of ALL_ROLES) {
        const index = theme256Index(theme, role);
        expect(Number.isInteger(index) && index >= 0 && index <= 255).toBeTrue();
      }
      expect(theme256Index(theme, "background")).not.toBe(theme256Index(theme, "raised"));
    }
  });

  test("keeps temperature and hierarchy semantics distinct in 256 colors", () => {
    expect(theme256Index("iron gall", "focus / accent"))
      .not.toBe(theme256Index("iron gall", "prose"));
    expect(theme256Index("iron gall", "focus / accent")).toBeLessThan(232);
    expect(theme256Index("iron gall", "compose accent"))
      .toBe(theme256Index("iron gall", "human edit"));
    expect(theme256Index("iron gall", "human edit"))
      .not.toBe(theme256Index("iron gall", "danger"));

    expect(theme256Index("parchment", "focus / accent"))
      .not.toBe(theme256Index("parchment", "tag · canon"));
    expect(theme256Index("parchment", "summary"))
      .not.toBe(theme256Index("parchment", "chrome"));

    expect(theme256Index("bond", "summary"))
      .not.toBe(theme256Index("bond", "chrome"));
    expect(hex("bond", "summary")).not.toBe(hex("bond", "chrome"));
  });

  test("keeps parchment 256 chrome and canon readable against paper", () => {
    const background = xtermHex(theme256Index("parchment", "background"));
    const chrome = theme256Index("parchment", "chrome");
    const canon = theme256Index("parchment", "tag · canon");

    expect(contrast(background, xtermHex(chrome))).toBeGreaterThan(4.499);
    expect(contrast(background, xtermHex(canon))).toBeGreaterThan(4.499);
    expect(chrome).not.toBe(canon);
    expect(canon).not.toBe(theme256Index("parchment", "focus / accent"));
  });

  test("keeps specimen palette text visible on raised surfaces", () => {
    for (const theme of ["graphite", "bone"] as const) {
      const raised = hex(theme, "raised");
      expect(contrast(raised, hex(theme, "chrome"))).toBeGreaterThan(4.499);
      expect(contrast(raised, hex(theme, "tag · discarded"))).toBeGreaterThan(2.999);

      const raised256 = xtermHex(theme256Index(theme, "raised"));
      expect(contrast(raised256, xtermHex(theme256Index(theme, "chrome"))))
        .toBeGreaterThan(4.499);
      expect(contrast(raised256, xtermHex(theme256Index(theme, "tag · discarded"))))
        .toBeGreaterThan(2.999);
    }
    expect(contrast(hex("bone", "raised"), hex("bone", "dimmed page")))
      .toBeGreaterThan(2.499);
    expect(contrast(
      xtermHex(theme256Index("bone", "raised")),
      xtermHex(theme256Index("bone", "dimmed page"))
    )).toBeGreaterThan(2.499);
  });

  test("keeps the bone accent readable on its paper surfaces", () => {
    for (const surface of ["background", "raised"] as const) {
      expect(contrast(hex("bone", surface), hex("bone", "focus / accent")))
        .toBeGreaterThan(4.499);
      expect(contrast(
        xtermHex(theme256Index("bone", surface)),
        xtermHex(theme256Index("bone", "focus / accent"))
      )).toBeGreaterThan(4.499);
    }
  });

  test("keeps secondary bone text readable", () => {
    for (const depth of ["truecolor", "256"] as const) {
      const background = depth === "truecolor"
        ? hex("bone", "background") : xtermHex(theme256Index("bone", "background"));
      expect(contrast(background, displayHex("bone", depth, "human edit dim")))
        .toBeGreaterThan(4.499);
      for (const surface of ["background", "raised"] as const) {
        const surfaceColor = depth === "truecolor"
          ? hex("bone", surface) : xtermHex(theme256Index("bone", surface));
        expect(contrast(surfaceColor, displayHex("bone", depth, "tag · draft")))
          .toBeGreaterThan(4.499);
      }
    }
  });

  test("keeps specimen fresh ink moving toward resting prose", () => {
    for (const [theme, direction] of [["graphite", -1], ["bone", 1]] as const) {
      for (const depth of ["truecolor", "256"] as const) {
        const steps = ["streaming", "fresh 1", "fresh 2", "prose"] as const;
        const luminances = steps.map((role) => relativeLuminance(displayHex(theme, depth, role)));
        expect(luminances.every((value, index) => index === 0
          || direction * luminances[index - 1]! < direction * value)).toBeTrue();
      }
    }
  });

  test("keeps the warning band distinct from normal high-contrast accent", () => {
    const palette = createPalette("hi-contrast dark", "truecolor");
    expect(palette.contextWarning).not.toBe(palette.color("focus / accent"));
    expect(contrast("#000000", palette.contextWarning as string)).toBeGreaterThan(4.499);
    expect(theme256ContextWarning("hi-contrast dark"))
      .not.toBe(theme256Index("hi-contrast dark", "focus / accent"));
    expect(contrast("#000000", xtermHex(theme256ContextWarning("hi-contrast dark"))))
      .toBeGreaterThan(4.499);
  });

  test("keeps all four context-breakdown categories distinct and visible", () => {
    for (const theme of THEME_NAMES) {
      for (const depth of ["truecolor", "256"] as const) {
        const background = depth === "truecolor"
          ? hex(theme, "background") : xtermHex(theme256Index(theme, "background"));
        const colors = BREAKDOWN_ROLES.map((role) => displayHex(theme, depth, role));

        expect(new Set(colors).size).toBe(BREAKDOWN_ROLES.length);
        for (const color of colors) expect(contrast(background, color)).toBeGreaterThan(2.999);
      }
    }
  });

  test("keeps visual context visible in every theme", () => {
    for (const theme of THEME_NAMES) {
      for (const depth of ["truecolor", "256"] as const) {
        const background = depth === "truecolor"
          ? hex(theme, "background") : xtermHex(theme256Index(theme, "background"));
        const visual = displayHex(theme, depth, "context visual");
        expect(contrast(background, visual)).toBeGreaterThan(2.749);
        if (theme === "graphite" || theme === "bone") {
          expect(contrast(background, visual)).toBeGreaterThan(2.999);
        }
      }
    }
  });

  test("keeps all seven starter logo bands distinct and visible", () => {
    for (const theme of THEME_NAMES) {
      for (const depth of ["truecolor", "256"] as const) {
        const background = depth === "truecolor"
          ? hex(theme, "background") : xtermHex(theme256Index(theme, "background"));
        const colors = LOGO_ROLES.map((role) => displayHex(theme, depth, role));
        const hues = colors.map(hue);

        expect(new Set(colors).size).toBe(7);
        for (const color of colors) expect(contrast(background, color)).toBeGreaterThan(2.999);
        expect(hues.every((value, index) => index === 0 || hues[index - 1]! < value)).toBeTrue();
      }
    }
  });

  test("keeps both response-growth pulse colors distinct from request fill", () => {
    // Request ink is severity-keyed: normal → focus / accent, warning →
    // context warning, over → danger. Both pulse phases must stay off that set
    // so a phase never merges with the adjacent request segment.
    const requestFills: readonly DisplayRole[] =
      ["focus / accent", "context warning", "danger"];
    for (const theme of THEME_NAMES) {
      for (const depth of ["truecolor", "256"] as const) {
        const growth = displayHex(theme, depth, "context growth");
        const pulse = displayHex(theme, depth, "context growth pulse");
        expect(growth).not.toBe(pulse);
        for (const fill of requestFills) {
          const request = displayHex(theme, depth, fill);
          expect(growth).not.toBe(request);
          expect(pulse).not.toBe(request);
        }
      }
    }
  });

  test("keeps request severity and destructive ink distinct", () => {
    const requestFills: readonly DisplayRole[] =
      ["focus / accent", "context warning", "danger"];
    for (const theme of THEME_NAMES) {
      for (const depth of ["truecolor", "256"] as const) {
        const fills = requestFills.map((role) => displayHex(theme, depth, role));
        expect(new Set(fills).size).toBe(requestFills.length);
        if (theme === "graphite" || theme === "bone") {
          expect(displayHex(theme, depth, "danger"))
            .not.toBe(displayHex(theme, depth, "accent · deep"));
        }
      }
    }
    for (const depth of ["truecolor", "256"] as const) {
      expect(contrast(
        displayHex("bone", depth, "focus / accent"),
        displayHex("bone", depth, "danger")
      )).toBeGreaterThan(1.499);
      expect(contrast(
        displayHex("bone", depth, "focus / accent"),
        displayHex("bone", depth, "accent · deep")
      )).toBeGreaterThan(1.299);
    }
  });

  test("connection warning uses background ink on a contrasting danger fill", () => {
    const rendered = renderConnectionBanner([[]], {
      now: 1_000,
      connection: { down: true, attempt: 1, nextRetryAt: null, error: "offline" },
      hitRows: [null]
    } as never, 80);
    const warning = rendered[0]!.filter((part) => part.background === "danger");
    expect(warning.length).toBeGreaterThan(0);
    expect(warning.reduce((width, part) => width + visibleWidth(part.text), 0)).toBe(80);
    expect(rendered[0]!.every((part) => part.background === "danger")).toBeTrue();
    expect(new Set(warning.map((part) => part.role))).toEqual(new Set(["background"]));
    for (const theme of THEME_NAMES) {
      expect(contrast(hex(theme, "background"), hex(theme, "danger"))).toBeGreaterThan(4.499);
      expect(contrast(
        xtermHex(theme256Index(theme, "background")),
        xtermHex(theme256Index(theme, "danger"))
      )).toBeGreaterThan(4.499);
    }
  });
});

describe("user config normalization", () => {
  test("upgrades an old config with compose defaults", () => {
    expect(normalizeUserConfig({
      theme: "bond",
      factsRail: "off",
      quota: { date: "2026-07-21", words: 42 }
    })).toEqual({
      schemaVersion: 1,
      theme: "bond",
      factsRail: "off",
      composeFocus: "off",
      wordWrap: "on",
      asideThoughts: "hide",
      composeMaxHeight: null,
      quota: { date: "2026-07-21", words: 42 },
      updates: { mode: "notify", channel: "stable", skippedVersion: null },
      lastRunVersion: null,
      settingsViewMode: "simple",
      factsViewMode: "simple"
    });
  });

  test("accepts documented snake-case aliases and normalizes height", () => {
    expect(normalizeUserConfig({
      schemaVersion: 1,
      theme: "hi-contrast light",
      facts_rail: "off",
      compose_focus: "on",
      compose_max_height: 12.9,
      settings_view_mode: "advanced",
      updates: {
        mode: "off",
        channel: "beta",
        skippedVersion: "1.2.3"
      },
      quota: { date: "", words: 0 },
      lastRunVersion: "0.5.0"
    })).toMatchObject({
      schemaVersion: 1,
      theme: "hi-contrast light",
      factsRail: "off",
      composeFocus: "on",
      composeMaxHeight: 12,
      settingsViewMode: "advanced",
      updates: {
        mode: "off",
        channel: "beta",
        skippedVersion: "1.2.3"
      },
      lastRunVersion: "0.5.0"
    });
  });

  test("canonical null height wins over a stale legacy alias", () => {
    expect(normalizeUserConfig({
      composeMaxHeight: null,
      compose_max_height: 12
    }).composeMaxHeight).toBe(null);
  });

  test("falls back safely for malformed user-edited values", () => {
    expect(normalizeUserConfig({
      theme: "ultraviolet",
      factsRail: true,
      composeFocus: "yes",
      composeMaxHeight: 0,
      updates: {
        mode: "auto",
        channel: "nightly",
        skippedVersion: "01.2.3"
      },
      quota: { date: 12, words: "many" },
      lastRunVersion: "01.2.3"
    })).toEqual({
      schemaVersion: 1,
      theme: "lantern",
      factsRail: "auto",
      composeFocus: "off",
      wordWrap: "on",
      asideThoughts: "hide",
      composeMaxHeight: null,
      quota: { date: "", words: 0 },
      updates: { mode: "notify", channel: "stable", skippedVersion: null },
      lastRunVersion: null,
      settingsViewMode: "simple",
      factsViewMode: "simple"
    });
    expect(normalizeUserConfig(null)).toEqual(normalizeUserConfig([]));
  });

  test("migrates the legacy off default but keeps a schema 1 opt-out", () => {
    expect(normalizeUserConfig({ updates: { mode: "off" } }).updates.mode)
      .toBe("notify");
    expect(normalizeUserConfig({
      schemaVersion: 1,
      updates: { mode: "off" }
    }).updates.mode).toBe("off");
  });

  test("keeps word wrap on unless the config turns it off", () => {
    // An existing config file predates the key, and its editors already wrapped.
    expect(normalizeUserConfig({}).wordWrap).toBe("on");
    expect(normalizeUserConfig({ wordWrap: "off" }).wordWrap).toBe("off");
    expect(normalizeUserConfig({ word_wrap: "off" }).wordWrap).toBe("off");
    expect(normalizeUserConfig({ wordWrap: "sometimes" }).wordWrap).toBe("on");
  });

  test("accepts the specimen themes from user config", () => {
    expect(normalizeUserConfig({ theme: "graphite" }).theme).toBe("graphite");
    expect(normalizeUserConfig({ theme: "bone" }).theme).toBe("bone");
  });
});
