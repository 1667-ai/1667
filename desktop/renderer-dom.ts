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

export function actionButton(className: string, label: string, action: () => void, title?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  if (title !== undefined) button.title = title;
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

export function resizeTextarea(text: HTMLTextAreaElement): void {
  if (!text.isConnected) return;
  text.style.height = "auto";
  text.style.height = `${Math.max(88, text.scrollHeight)}px`;
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
