import {
  contextSeverity,
  formatTokensNarrow,
  formatTokensScaled,
  OFF_SCALE_TOKENS,
  formatTokensEstimate,
  gaugeFill,
  RAIL_CONTENT_WIDTH,
  type ContextSeverity,
  type RailModel,
  type RequestWindow
} from "../../rail.js";
import {
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./frame.js";

const GAUGE_INK = "▮";
/** The same solid cell as the ink, dimmed. A hollow glyph turns the track into
 *  a row of empty boxes and outshouts the fill it exists to measure. */
const GAUGE_FREE = "▮";
/** Collapsed bar cells; the rest of the row carries the free-space readout. */
const GAUGE_CELLS = 20;
const LEGEND_HALF = 15;
const LEGEND_GAP = RAIL_CONTENT_WIDTH - LEGEND_HALF * 2;
const REQUEST_LABEL = "next request  ";
const WINDOW_HINT = "set context window · settings (,)";

type Category = readonly [keyof RailModel["breakdown"], DisplayRole];

const CATEGORIES: readonly Category[] = [
  ["voice", "context voice"],
  ["facts", "context facts"],
  ["recent", "context recent"],
  ["summary", "context summary"]
];

/** The rail footer, doc 12a collapsed and doc 12b expanded. The breakdown
 * *replaces* the collapsed block instead of stacking beneath it, so the meter
 * occupies one place in the rail whichever state it is in.
 *
 * `rows` is what the rail can actually give it: the rail engages on width
 * alone, so a thin split pane can be shorter than the expanded block. The forms
 * below are ordered tallest first and shed decoration before meaning — the rule
 * goes, then the gauge, and the request line itself is the last to go. Every
 * form keeps the chapter notice for as long as it has a row to spare, because
 * that notice is the only actionable thing the meter ever says. */
export function contextMeterLines(model: RailModel, expanded: boolean, rows: number): FrameLine[] {
  const severity = contextSeverity(model.window);
  const request = requestLine(model, severity);
  const gauge = gaugeLine(model, severity);
  const forms = [
    ...expanded ? [expandedMeter(model, severity)] : [],
    [rule(), request, gauge],
    [request, gauge],
    [request]
  ];
  const notice = model.chapterNotice === null ? []
    : [[segment(truncate(model.chapterNotice, RAIL_CONTENT_WIDTH), "focus / accent")] as FrameLine];
  const form = forms.find((candidate) => candidate.length + notice.length <= rows);
  if (form !== undefined) return [...form, ...notice];
  // A single row left: the request outranks even the notice.
  return rows >= 1 ? [request] : [];
}

/** Doc 12a: sized against the window when there is one, a plain estimate when
 * there is not — never a percentage the meter cannot honestly compute. */
function requestLine(model: RailModel, severity: ContextSeverity): FrameLine {
  return [
    segment(REQUEST_LABEL, "chrome"),
    segment(requestValue(model, RAIL_CONTENT_WIDTH - visibleWidth(REQUEST_LABEL)), valueRole(severity))
  ];
}

/** The gauge, or — with no window to size it against — the way to get one. */
function gaugeLine(model: RailModel, severity: ContextSeverity): FrameLine {
  if (model.window === null) return [contextWindowHint()];
  const column = RAIL_CONTENT_WIDTH - GAUGE_CELLS;
  const free = freeReadout(model.window, severity);
  return [
    ...bar(model.window.fill, GAUGE_CELLS, [[1, inkRole(severity)]]),
    // The gauge keeps a fixed width so the bar does not jitter between frames;
    // the readout beside it is budgeted to whatever that leaves.
    { ...free, text: truncate(free.text, column).padStart(column) }
  ];
}

function expandedMeter(model: RailModel, severity: ContextSeverity): FrameLine[] {
  const window = model.window;
  // An unknown window can size no bar at all — neither the whole request nor a
  // category share of it — so the expansion is category totals and nothing else.
  return [
    [segment("context", "focus / accent"), segment(" · next request", "chrome")],
    [],
    ...window === null ? [] : [breakdownBar(model, window), []],
    legendRow(CATEGORIES.slice(0, 2), model),
    legendRow(CATEGORIES.slice(2), model),
    rule(),
    ...totalsLines(model, severity)
  ];
}

/** Doc 12b: the request's own fill is split by category, and whatever the
 * window has left over stays visibly free beside it. */
function breakdownBar(model: RailModel, window: RequestWindow): FrameLine {
  return bar(window.fill, RAIL_CONTENT_WIDTH,
    CATEGORIES.map(([key, role]) => [model.breakdown[key], role] as const));
}

/** One gauge for both meters: ink cells split between the slices in proportion,
 * then whatever the window has left over. A slice too small for a cell yields
 * to the ones before it rather than stealing from the free remainder. */
function bar(
  fill: number,
  cells: number,
  slices: ReadonlyArray<readonly [number, DisplayRole]>
): FrameLine {
  const filled = gaugeFill(fill, cells);
  const total = slices.reduce((sum, [weight]) => sum + weight, 0);
  const line: FrameLine = [];
  let used = 0;
  let cumulative = 0;
  for (const [weight, role] of slices) {
    cumulative += weight;
    // Allocate by cumulative share so rounding never drops a slice below the
    // one before it or overruns the measured fill.
    const target = total <= 0 ? 0
      : Math.max(used, Math.min(filled, Math.round(cumulative / total * filled)));
    if (target > used) line.push(segment(GAUGE_INK.repeat(target - used), role));
    used = target;
  }
  if (used < cells) line.push(segment(GAUGE_FREE.repeat(cells - used), "dimmed page"));
  return line;
}

/** An unknown window's estimate is a locale-formatted count that can run long,
 * so the hint keeps its own row rather than being clipped off the end of one. */
function totalsLines(model: RailModel, severity: ContextSeverity): FrameLine[] {
  const window = model.window;
  if (window === null) {
    return [
      [segment(requestValue(model, RAIL_CONTENT_WIDTH), valueRole(severity))],
      [contextWindowHint()]
    ];
  }
  const free = freeReadout(window, severity);
  return [[
    segment(requestValue(model, RAIL_CONTENT_WIDTH - visibleWidth(free.text) - 3), valueRole(severity)),
    segment(" · ", "chrome"),
    free
  ]];
}

function contextWindowHint(): FrameSegment {
  return segment(
    WINDOW_HINT,
    "chrome",
    { kind: "settings-row", row: "context-window" }
  );
}

/** What the window has left, or that it has almost nothing left. One statement
 * of the wording and of the band, for both meters. */
function freeReadout(window: RequestWindow, severity: ContextSeverity): FrameSegment {
  const role = severity === "normal" ? "chrome" : valueRole(severity);
  return severity === "over"
    ? segment("near full", role)
    : segment(`${formatTokensScaled(window.free)} free`, role);
}

function legendRow(pair: readonly Category[], model: RailModel): FrameLine {
  return pair.flatMap(([key, role], offset) => {
    // Each half owns exactly its cells: the swatch, a space, the label, and
    // whatever the count can spend beside them. No token value may widen it.
    const lead = visibleWidth(GAUGE_INK) + 1 + key.length;
    const count = truncate(railTokenCount(model.breakdown[key]), Math.max(1, LEGEND_HALF - lead - 1));
    const pad = LEGEND_HALF - lead - visibleWidth(count);
    return [
      ...offset > 0 ? [segment(" ".repeat(LEGEND_GAP))] : [],
      segment(GAUGE_INK, role),
      segment(` ${key}`, "chrome"),
      segment(" ".repeat(pad)),
      segment(count, "prose · dim")
    ];
  });
}

function rule(): FrameLine {
  return [segment("─".repeat(RAIL_CONTENT_WIDTH), "dimmed page")];
}

/** An estimate too long for the cells it was given falls back to the scaled
 * form rather than losing its unit to a clip. */
function requestValue(model: RailModel, available: number): string {
  const window = model.window;
  if (window === null) {
    const exact = `~${model.contextTokens.toLocaleString("en-US")} tokens`;
    return visibleWidth(exact) <= available
      ? exact : truncate(`${formatTokensEstimate(model.contextTokens)} tokens`, available);
  }
  return truncate(`${formatTokensEstimate(model.contextTokens)} / ${formatTokensScaled(window.size)}`, available);
}

function inkRole(severity: ContextSeverity): DisplayRole {
  return severity === "over" ? "danger" : severity === "warning" ? "context warning" : "focus / accent";
}

/** Doc 12a paints an untroubled request value sepia and leaves the lantern to
 * the gauge; only the amber and ember bands reach the number itself. That is
 * also what keeps a tight window visible in the expanded state, which draws no
 * collapsed gauge at all. */
function valueRole(severity: ContextSeverity): DisplayRole {
  return severity === "over" ? "danger text" : severity === "warning" ? "context warning" : "summary";
}

/** Fixed-width rail value: every category remains visible in the legend half.
 * A count below a thousand is exact, and one off the top of the scale already
 * says so itself — neither wants a `~`, and the off-scale form needs the cell
 * that a `~` would cost to keep its unit. */
function railTokenCount(tokens: number): string {
  const value = Math.max(0, tokens);
  const narrow = formatTokensNarrow(value);
  return value < 1_000 || narrow === OFF_SCALE_TOKENS ? narrow : `~${narrow}`;
}
