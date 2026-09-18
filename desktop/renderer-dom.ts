/** Small DOM-building helpers shared by every renderer view module. Keep this
 * file tiny; it exists so `renderer-view.ts` and the newer view files
 * (`renderer-shell-view.ts`, `renderer-inspector-view.ts`, ...) do not
 * duplicate the same element-building pattern. */

export type ElementChild = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: ElementChild[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  for (const child of children) {
    if (typeof child === "string") {
      if (child.length > 0) element.append(document.createTextNode(child));
    } else {
      element.append(child);
    }
  }
  return element;
}

/** Focuses a popover's own card right after it first mounts (D-05):
 * `.popover-card` gets `tabindex="-1"` so it is programmatically focusable
 * without joining the Tab order, mirroring the palette's own `focusInitial`
 * pattern for its input. Queued as a microtask so it wins over `render()`'s
 * generic focus-preservation, which runs synchronously just afterward and
 * would otherwise refocus whatever manuscript control the popover now covers
 * (review-fixes-3 #4). Call only when the popover just opened (not on every
 * re-render while it is already open) — the caller already tracks that. */
export function focusPopoverCard(popover: HTMLElement): void {
  const card = popover.querySelector<HTMLElement>(".popover-card");
  if (card === null) return;
  card.tabIndex = -1;
  queueMicrotask(() => card.focus());
}

/** `key`, when given, renders as a bordered `.key-hint` chip after the label
 * (R-26) instead of being folded into the label text (a stray "Retake r"). */
export function actionButton(className: string, label: string, action: () => void, title?: string, key?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  if (title !== undefined) button.title = title;
  if (key !== undefined) button.append(el("span", "key-hint", key));
  button.addEventListener("click", action);
  return button;
}

export function bindDraftInput(control: HTMLInputElement | HTMLTextAreaElement, commit: () => void): void {
  control.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing) return;
    commit();
  });
  control.addEventListener("compositionend", commit);
}

export function resizeTextarea(text: HTMLTextAreaElement, minHeight = 88): void {
  if (!text.isConnected) return;
  text.style.height = "auto";
  text.style.height = `${Math.max(minHeight, text.scrollHeight)}px`;
}

/** The eyebrow + serif title + description heading every list-style
 * destination (Map, Inspect, Facts, Chapters) opens with, with an optional
 * control (usually a `.panel-heading-actions` group) at the right. */
export function panelHeading(title: string, description: string, control?: HTMLElement): HTMLElement {
  const heading = el("div", "panel-heading", el("div", "panel-heading-copy", el("span", "eyebrow", "Workspace"), el("h2", "", title), el("p", "", description)));
  if (control !== undefined) heading.append(control);
  return heading;
}

export function metricRow(label: string, value: string): HTMLElement {
  return el("div", "metric-row", el("span", "", label), el("strong", "", value));
}

/** A text selection inside one part's prose, by part key and text offsets. */
export interface ProseSelection {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Record a selection inside a `.part-prose` so a full re-render can restore
 *  it. The prose is one text node, so the range offsets are text offsets. */
export function captureProseSelection(): ProseSelection | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const prose = range.startContainer.parentElement?.closest<HTMLElement>(".part-prose") ?? null;
  if (prose === null || prose.firstChild === null) return null;
  if (range.startContainer !== prose.firstChild || range.endContainer !== prose.firstChild) return null;
  const key = prose.closest<HTMLElement>("[data-preserve]")?.dataset.preserve;
  return key === undefined ? null : { key, start: range.startOffset, end: range.endOffset };
}

export function restoreProseSelection(root: HTMLElement, saved: ProseSelection | null): void {
  if (saved === null) return;
  const card = [...root.querySelectorAll<HTMLElement>("[data-preserve]")].find((candidate) => candidate.dataset.preserve === saved.key);
  const text = card?.querySelector(".part-prose")?.firstChild ?? null;
  if (text === null || text.nodeType !== Node.TEXT_NODE || (text.textContent ?? "").length < saved.end) return;
  const range = document.createRange();
  range.setStart(text, saved.start);
  range.setEnd(text, saved.end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
