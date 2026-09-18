/** Controls library (D-15…D-21, COMPONENTS.md §03): small view functions
 * that return elements, tokens only. `renderer-settings-controls.ts` wraps
 * these with the `data-settings-field` / `data-preserve` plumbing a settings
 * field needs; phase 4b (Facts, Chapters) reuses these primitives directly.
 * Law 1: bars are output, brackets are input — a settable number wears
 * `‹ ›` and a positional track with a `┆` default tick (D-17); a read-only
 * number is a meter (D-24, not here) and never grows chevrons. */

import { el } from "./renderer-dom.js";

export type ButtonKind = "primary" | "secondary" | "tertiary" | "destructive";

/** D-15 button — primary (amber fill, one per surface), secondary (outline),
 * tertiary (text, `--muted`), destructive (tertiary in `--danger`). The key
 * hint renders inside as a bordered `--type-meta` chip; a disabled button
 * states its reason beside it. */
export function button(
  kind: ButtonKind,
  label: string,
  key: string | undefined,
  action: () => void,
  disabledReason?: string
): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `button control-button control-button-${kind}`;
  control.append(document.createTextNode(label));
  if (key !== undefined) control.append(el("span", "key-hint", key));
  if (disabledReason !== undefined) {
    control.disabled = true;
    control.title = disabledReason;
    control.append(el("span", "reason", disabledReason));
  }
  control.addEventListener("click", action);
  return control;
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** D-16 segmented — up to four options that are the information and fit one
 * line; active is a graphite (`--bar`) block, never amber. */
export function segmented<T extends string>(
  options: readonly SegmentedOption<T>[],
  value: T,
  onChange: (value: T) => void
): HTMLElement {
  const wrapper = el("div", "segmented");
  wrapper.setAttribute("role", "group");
  for (const option of options) {
    const active = option.value === value;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `segmented-option${active ? " active" : ""}`;
    item.textContent = option.label;
    item.setAttribute("aria-pressed", String(active));
    item.addEventListener("click", () => { if (!active) onChange(option.value); });
    wrapper.append(item);
  }
  return wrapper;
}

export interface ScalarConfig {
  /** `null` renders the blank/"provider default" state. */
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Where the `┆` default tick sits on the track. */
  readonly defaultValue: number;
  readonly onChange: (raw: string) => void;
  readonly format?: (value: number) => string;
  /** Stable key carried as `data-preserve` so a re-render restores whatever
   * the writer had typed, even text that does not parse (`render()` in
   * `renderer.ts` does the actual restoring, by matching this key). */
  readonly id: string;
  /** The caller already knows the typed text failed to parse (its own
   * validation keeps the document unchanged and records a field error); the
   * control does not infer this on its own. */
  readonly invalid?: boolean;
  readonly disabledReason?: string;
  /** Shown in the input when blank. Defaults to "provider default", right
   * for a sampling knob; pass something else ("no limit", say) elsewhere. */
  readonly placeholder?: string;
  /** Law 1 still applies once a scalar's range is wide enough (a token cap
   * in the hundreds of thousands, say) that a positional handle cannot show
   * a meaningful position — the track becomes a second, uninformative
   * "slider" beside the chevrons rather than the shape the law intends.
   * `false` keeps the stepper (chevrons + typed value) and drops the track.
   * Defaults to `true` — every other scalar keeps its track unchanged. */
  readonly track?: boolean;
}

const DEFAULT_SCALAR_FORMAT = (value: number): string => String(value);

/** D-17 scalar — `‹ value ›` chevrons step (click, ←→ on a focused chevron,
 * ⇧ = ×10 steps); the value is a typed `<input type="text">`; a positional
 * track beneath carries a `┆` tick at the default and a draggable handle. An
 * invalid typed value pins the handle to the nearer wall in `--ember` and
 * never blocks typing. Disabled renders `‹ — ›` plus the reason. */
export function scalar(config: ScalarConfig): HTMLElement {
  const { min, max, step, defaultValue } = config;
  const format = config.format ?? DEFAULT_SCALAR_FORMAT;
  const disabled = config.disabledReason !== undefined;
  const wrapper = el("div", `scalar${config.invalid === true ? " invalid" : ""}${disabled ? " disabled" : ""}`);
  if (disabled) wrapper.title = config.disabledReason!;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "scalar-input";
  input.inputMode = Number.isInteger(step) ? "numeric" : "decimal";
  input.value = disabled ? "" : config.value === null ? "" : format(config.value);
  input.placeholder = disabled ? "—" : config.placeholder ?? "provider default";
  input.dataset.preserve = config.id;
  input.disabled = disabled;
  input.addEventListener("input", () => config.onChange(input.value));

  const currentNumeric = (): number => {
    const parsed = Number(input.value.trim());
    return Number.isFinite(parsed) ? parsed : config.value ?? defaultValue;
  };
  const step_ = (direction: 1 | -1, big: boolean): void => {
    if (disabled) return;
    const amount = step * (big ? 10 : 1);
    input.value = format(steppedScalarValue(currentNumeric(), direction * amount, min, max, step));
    config.onChange(input.value);
  };
  const stepDown = button("tertiary", "‹", undefined, () => step_(-1, false));
  stepDown.classList.add("scalar-step", "scalar-step-down");
  stepDown.setAttribute("aria-label", "Decrease");
  stepDown.disabled = disabled;
  // A stable, control-specific `data-preserve` key (not the generic
  // `.control-button` class fallback `render()` uses for an unkeyed button)
  // so a focused chevron or handle survives the re-render its own arrow
  // press causes, landing back on itself rather than the first same-class
  // control anywhere on the page.
  stepDown.dataset.preserve = `scalar:${config.id}:down`;
  const stepUp = button("tertiary", "›", undefined, () => step_(1, false));
  stepUp.classList.add("scalar-step", "scalar-step-up");
  stepUp.setAttribute("aria-label", "Increase");
  stepUp.disabled = disabled;
  stepUp.dataset.preserve = `scalar:${config.id}:up`;
  for (const [control, direction] of [[stepDown, -1], [stepUp, 1]] as const) {
    control.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      step_(event.key === "ArrowRight" ? 1 : -1, event.shiftKey);
    });
  }

  const showTrack = config.track !== false;
  const track = el("div", "scalar-track");
  const fill = el("div", "scalar-track-fill");
  const tick = el("div", "scalar-track-tick");
  const handle = el("div", "scalar-track-handle");
  handle.dataset.preserve = `scalar:${config.id}:handle`;
  handle.setAttribute("role", "slider");
  handle.tabIndex = disabled ? -1 : 0;
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  track.append(fill, tick, handle);

  const positionTrack = (): void => {
    if (!showTrack) return;
    const raw = input.value.trim();
    const parsedRaw = raw.length === 0 ? null : Number(raw);
    const parsed = parsedRaw !== null && Number.isFinite(parsedRaw) ? parsedRaw : null;
    const inRange = parsed !== null && parsed >= min && parsed <= max;
    const pinned = config.invalid === true && !inRange;
    const shown = pinned
      ? nearerWall(parsed ?? config.value ?? defaultValue, min, max)
      : inRange
        ? parsed!
        : (config.value ?? defaultValue);
    const fraction = max === min ? 0 : (clamp(shown, min, max) - min) / (max - min);
    fill.style.width = `${fraction * 100}%`;
    handle.style.left = `${fraction * 100}%`;
    handle.setAttribute("aria-valuenow", String(shown));
    handle.classList.toggle("pinned", pinned);
  };
  const defaultFraction = max === min ? 0 : (clamp(defaultValue, min, max) - min) / (max - min);
  tick.style.left = `${defaultFraction * 100}%`;
  positionTrack();

  // A pointer move during a drag only updates the local value and the
  // handle's own position; `onChange` fires once the drag ends. Calling
  // `onChange` on every move re-renders the tree synchronously (the caller's
  // state update), which detaches this very handle mid-drag and strands the
  // pointer capture on an element no longer in the document.
  let dragging = false;
  const applyPointer = (event: PointerEvent): void => {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const next = roundToStep(min + fraction * (max - min), step);
    input.value = format(clamp(next, min, max));
    positionTrack();
  };
  const commitDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    config.onChange(input.value);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (disabled) return;
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    applyPointer(event);
  });
  handle.addEventListener("pointermove", (event) => { if (dragging) applyPointer(event); });
  handle.addEventListener("pointerup", (event) => {
    applyPointer(event);
    handle.releasePointerCapture(event.pointerId);
    commitDrag();
  });
  handle.addEventListener("lostpointercapture", commitDrag);
  handle.addEventListener("keydown", (event) => {
    if (disabled) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    step_(event.key === "ArrowRight" ? 1 : -1, event.shiftKey);
  });

  wrapper.append(stepDown, input, stepUp, ...(showTrack ? [track] : []));
  if (!showTrack) wrapper.classList.add("scalar-no-track");
  return wrapper;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const rounded = Math.round(value / step) * step;
  // Kill float noise (0.1 + 0.2 stepping) without inventing a display precision policy.
  return Math.round(rounded * 1e6) / 1e6;
}

/** One chevron/keyboard step: round to the step size, *then* clamp to the
 * bounds, matching the drag path (`applyPointer`) below — rounding after an
 * earlier clamp can walk back out of range (min 1, step 100: decreasing 100
 * clamps to 1, then rounds to 0). Exported for the unit test
 * (review-fixes-3 #12). */
export function steppedScalarValue(current: number, delta: number, min: number, max: number, step: number): number {
  return clamp(roundToStep(current + delta, step), min, max);
}

/** No numeric value survives garbage text, so an unparseable typed value
 * pins toward whichever wall the last known value sat closer to; this is a
 * documented simplification, not a reconstruction of what the writer typed. */
function nearerWall(reference: number, min: number, max: number): number {
  const midpoint = (min + max) / 2;
  return reference >= midpoint ? max : min;
}

/** D-18 field — eyebrow label above an arbitrary input. */
export function field(label: string, input: HTMLElement): HTMLElement {
  return el("label", "field", el("span", "field-label", label), input);
}

/** D-18 text area — prose areas use the serif. */
export function textArea(value: string, onChange: (value: string) => void, options: { readonly prose?: boolean; readonly rows?: number } = {}): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  area.className = `field-textarea${options.prose === true ? " prose" : ""}`;
  area.rows = options.rows ?? 4;
  area.value = value;
  area.addEventListener("input", () => onChange(area.value));
  return area;
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** D-19 select — `label ▾`; keeps a native `<select>` under the hood
 * (accessible, platform-native), styled by `renderer.css`. */
export function select(options: readonly SelectOption[], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const control = document.createElement("select");
  control.className = "field-select";
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === value;
    control.append(item);
  }
  control.addEventListener("change", () => onChange(control.value));
  return control;
}

export type ChipVariant = "wash" | "outline" | "graphite" | "sage";

/** D-20 chip — wash = state in force, outline = not yet, graphite = active
 * filter, sage = human. Shares `.chip.<variant>` with the existing
 * `.chip.wash` rule (phase 1's Facts-in-force chips) rather than a second
 * naming convention. */
export function chip(text: string, variant: ChipVariant): HTMLElement {
  return el("span", `chip ${variant}`, text);
}

/** D-21 toggle — a boolean is two words (`<label> on · off`) rendered as two
 * adjacent buttons, never a switch or `[x]`. The wrapper itself carries
 * `aria-pressed` mirroring `on`, so a caller that needs one addressable
 * element (a keyboard shortcut's target, for example) still has one. */
export function toggle(label: string, on: boolean, onChange: (next: boolean) => void): HTMLElement {
  const wrapper = el("div", "toggle");
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-pressed", String(on));
  wrapper.append(el("span", "toggle-label", label));
  const onButton = document.createElement("button");
  onButton.type = "button";
  onButton.className = `toggle-option toggle-on${on ? " active" : ""}`;
  onButton.textContent = "on";
  onButton.setAttribute("aria-pressed", String(on));
  onButton.addEventListener("click", () => { if (!on) onChange(true); });
  const offButton = document.createElement("button");
  offButton.type = "button";
  offButton.className = `toggle-option toggle-off${on ? "" : " active"}`;
  offButton.textContent = "off";
  offButton.setAttribute("aria-pressed", String(!on));
  offButton.addEventListener("click", () => { if (on) onChange(false); });
  wrapper.append(onButton, offButton);
  return wrapper;
}
