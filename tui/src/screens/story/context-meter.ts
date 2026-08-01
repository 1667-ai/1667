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
import type { FrameDeadlineCollector } from "../../animation-deadline.js";
import {
  segment,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./frame.js";

const GROWTH_PULSE_MS = 1_200;

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
/** The half of C-22's over-window statement that says what to do about it. */
const OVER_REMEDY = "summarize or drop a fact";

type Category = readonly [keyof RailModel["breakdown"], DisplayRole];

const CATEGORIES: readonly Category[] = [
  ["voice", "context voice"],
  ["facts", "context facts"],
  ["recent", "context recent"],
  ["summary", "context summary"],
  ["note", "context note"]
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
export function contextMeterLines(
  model: RailModel,
  expanded: boolean,
  rows: number,
  now = 0,
  deadlines?: FrameDeadlineCollector,
  /** When false, paint a static growth role and skip pulse deadlines. Compose
   *  focus collapses both phases to chrome, so a deadline would only repaint. */
  pulse = true
): FrameLine[] {
  const forecast = forecastWindow(model);
  const severity = contextSeverity(forecast);
  const request = requestLine(model, severity);
  const growthRole = contextGrowthRole(now, pulse);
  const gauge = gaugeLine(model, forecast, severity, growthRole);
  const forms = [
    ...expanded ? [expandedMeter(model, forecast, severity, growthRole)] : [],
    [rule(), request, gauge],
    [request, gauge],
    [request]
  ];
  // What to do about it, in the two cases the meter can answer: the request
  // does not fit, or a chapter is worth summarizing. Both outrank decoration
  // and both yield to the request line itself.
  const tail: FrameLine[] = [
    ...severity === "over"
      ? [[segment(OVER_REMEDY, "danger text")] as FrameLine]
      : [],
    ...model.chapterNotice === null
      ? []
      : [[segment(truncate(model.chapterNotice, RAIL_CONTENT_WIDTH), "focus / accent")] as FrameLine]
  ];
  const form = forms.find((candidate) => candidate.length + tail.length <= rows);
  // A single row left: the request outranks even the notice.
  const lines = form !== undefined
    ? [...form, ...tail]
    : rows >= 1 ? [request] : [];
  // Pulse only when a growth segment actually lands and phases can change pixels.
  if (pulse && deadlines !== undefined && linesShowGrowthPulse(lines)) {
    deadlines.at(now - (now % GROWTH_PULSE_MS) + GROWTH_PULSE_MS);
  }
  return lines;
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
function gaugeLine(
  model: RailModel,
  forecast: RequestWindow | null,
  severity: ContextSeverity,
  growthRole: DisplayRole
): FrameLine {
  if (model.window === null || forecast === null) return [contextWindowHint()];
  const column = RAIL_CONTENT_WIDTH - GAUGE_CELLS;
  const free = freeReadout(forecast, severity, model, column);
  return [
    ...bar(model.window, model.growthTokens, GAUGE_CELLS, [[1, inkRole(severity)]], growthRole),
    // The gauge keeps a fixed width so the bar does not jitter between frames;
    // the readout beside it is budgeted to whatever that leaves.
    { ...free, text: truncate(free.text, column).padStart(column) }
  ];
}

function expandedMeter(
  model: RailModel,
  forecast: RequestWindow | null,
  severity: ContextSeverity,
  growthRole: DisplayRole
): FrameLine[] {
  const window = model.window;
  // An unknown window can size no bar at all — neither the whole request nor a
  // category share of it — so the expansion is category totals and nothing else.
  return [
    [segment("context", "focus / accent"), segment(" · request + response", "chrome")],
    [],
    ...window === null ? [] : [breakdownBar(model, window, growthRole), []],
    legendRow(CATEGORIES.slice(0, 2), model),
    legendRow(CATEGORIES.slice(2, 4), model),
    ...model.breakdown.note > 0 ? [legendRow(CATEGORIES.slice(4), model)] : [],
    rule(),
    ...totalsLines(model, forecast, severity),
    [segment("view next request · ⌃r", "focus / accent", {
      kind: "inline-action", action: "open-request"
    })]
  ];
}

/** Doc 12b: the request's own fill is split by category, and whatever the
 * window has left over stays visibly free beside it. */
function breakdownBar(
  model: RailModel,
  window: RequestWindow,
  growthRole: DisplayRole
): FrameLine {
  return bar(
    window,
    model.growthTokens,
    RAIL_CONTENT_WIDTH,
    CATEGORIES.map(([key, role]) => [model.breakdown[key], role] as const),
    growthRole
  );
}

/** One gauge for both meters: ink cells split between the slices in proportion,
 * then whatever the window has left over. A slice too small for a cell yields
 * to the ones before it rather than stealing from the free remainder. */
function bar(
  window: RequestWindow,
  growthTokens: number,
  cells: number,
  slices: ReadonlyArray<readonly [number, DisplayRole]>,
  growthRole: DisplayRole
): FrameLine {
  const filled = gaugeFill(window.fill, cells);
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
  const measuredGrowth = gaugeFill(
    (window.size - window.free + growthTokens) / window.size,
    cells
  );
  // A positive response estimate owns at least one cell when a free cell still
  // remains for the sub-capacity remainder. Otherwise large windows can round
  // request and forecast to the same count and hide the pulse — but never paint
  // full while the forecast still has free tokens.
  const grown = growthTokens > 0 && window.free > 0 && used < cells - 1
    ? Math.max(measuredGrowth, used + 1)
    : measuredGrowth;
  if (grown > used) {
    line.push(segment(GAUGE_INK.repeat(grown - used), growthRole));
    used = grown;
  }
  if (used < cells) line.push(segment(GAUGE_FREE.repeat(cells - used), "dimmed page"));
  return line;
}

/** A slow two-tone pulse. The forecast never vanishes, so this reads as a
 *  breathing estimate instead of an alert blink. A static role keeps the
 *  segment when the pulse would not change any painted pixels. */
function contextGrowthRole(now: number, pulse: boolean): DisplayRole {
  if (!pulse) return "context growth";
  return Math.floor(now / GROWTH_PULSE_MS) % 2 === 0
    ? "context growth"
    : "context growth pulse";
}

function linesShowGrowthPulse(lines: readonly FrameLine[]): boolean {
  return lines.some((line) => line.some((part) =>
    part.role === "context growth" || part.role === "context growth pulse"
  ));
}

function forecastWindow(model: RailModel): RequestWindow | null {
  const window = model.window;
  if (window === null) return null;
  // `free` clamps at zero, so an already-over request has to add its overage
  // back before the forecast can say how far past the window it runs.
  const used = window.size - window.free + window.over + Math.max(0, model.growthTokens);
  return {
    size: window.size,
    free: Math.max(0, window.size - used),
    over: Math.max(0, used - window.size),
    fill: window.size <= 0 ? 0 : used / window.size
  };
}

/** An unknown window's estimate is a locale-formatted count that can run long,
 * so the hint keeps its own row rather than being clipped off the end of one.
 *
 * With a known window the request owns its budget first — growth over the
 * secondary cap. Free/cap take the rest of the row only when they still fit;
 * otherwise free keeps a second line rather than starving +~growth. */
function totalsLines(
  model: RailModel,
  forecast: RequestWindow | null,
  severity: ContextSeverity
): FrameLine[] {
  if (forecast === null) {
    return [
      [segment(requestValue(model, RAIL_CONTENT_WIDTH), valueRole(severity))],
      [contextWindowHint()]
    ];
  }
  const primary = requestValue(model, RAIL_CONTENT_WIDTH);
  const free = freeReadout(forecast, severity, model);
  const sep = " · ";
  if (visibleWidth(primary) + visibleWidth(sep) + visibleWidth(free.text) <= RAIL_CONTENT_WIDTH) {
    return [[
      segment(primary, valueRole(severity)),
      segment(sep, "chrome"),
      free
    ]];
  }
  return [
    [segment(primary, valueRole(severity))],
    [free]
  ];
}

function contextWindowHint(): FrameSegment {
  return segment(
    WINDOW_HINT,
    "chrome",
    { kind: "settings-row", row: "context-window", profilePurpose: "prose" }
  );
}

/** What the window has left, or that it has almost nothing left. One statement
 * of the wording and of the band, for both meters.
 *
 * When growth is forecast, the configured output cap rides here as secondary
 * chrome. Cap never sizes the pulse bar and never claims width before the
 * request line budgets +~growth (see totalsLines). */
function freeReadout(
  window: RequestWindow,
  severity: ContextSeverity,
  model: RailModel,
  maxWidth = RAIL_CONTENT_WIDTH
): FrameSegment {
  const role = severity === "normal" ? "chrome" : valueRole(severity);
  // C-22 states what happens next. `near full` dropped both useful halves: how
  // far past the window the request runs, and what shortens it. The overage
  // stays here beside the bar; the remedy takes its own row (see OVER_REMEDY).
  if (severity === "over") {
    return segment(window.over > 0 ? `over by ${formatTokensScaled(window.over)}` : "full", role);
  }
  const free = `${formatTokensScaled(window.free)} free`;
  if (model.growthTokens <= 0 || model.maxOutputTokens <= 0) return segment(free, role);
  const cap = `≤${formatTokensScaled(model.maxOutputTokens)}`;
  // Cap leads so a tight gauge column still keeps the secondary limit visible
  // beside free — only after requestValue has already kept +~growth.
  const candidates = [
    `${cap} ${free}`,
    `${cap} ${formatTokensScaled(window.free)}`,
    free
  ];
  const text = candidates.find((candidate) => visibleWidth(candidate) <= maxWidth) ?? free;
  return segment(text, role);
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
 * form rather than losing its unit to a clip.
 *
 * Growth is the likely response size (`+~N`). The configured output cap stays
 * secondary (`≤M`) and never sizes the pulse bar. When cells run short, the
 * secondary cap yields first so the bar estimate stays readable. */
function requestValue(model: RailModel, available: number): string {
  const window = model.window;
  if (window === null) {
    const candidates = [
      `~${model.contextTokens.toLocaleString("en-US")}${growthLabel(model)} tokens`,
      `${formatTokensEstimate(model.contextTokens)}${growthLabel(model, false)} tokens`,
      `${formatTokensEstimate(model.contextTokens)} tokens`
    ];
    for (const candidate of candidates) {
      if (visibleWidth(candidate) <= available) return candidate;
    }
    return truncate(`${formatTokensEstimate(model.contextTokens)} tokens`, available);
  }
  const current = formatTokensEstimate(model.contextTokens);
  const size = formatTokensScaled(window.size);
  const candidates = [
    `${current}${growthLabel(model)} / ${size}`,
    `${current}${growthLabel(model, false)} / ${size}`,
    `${current} / ${size}`
  ];
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= available) return candidate;
  }
  return truncate(`${current} / ${size}`, available);
}

/** Likely growth, optionally with the output cap as a tight secondary suffix. */
function growthLabel(model: RailModel, includeCap = true): string {
  if (model.growthTokens <= 0) return "";
  const estimate = ` +~${formatTokensScaled(model.growthTokens)}`;
  if (!includeCap || model.maxOutputTokens <= 0) return estimate;
  // No space before `≤` so estimate + cap often share one rail line.
  return `${estimate}≤${formatTokensScaled(model.maxOutputTokens)}`;
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
