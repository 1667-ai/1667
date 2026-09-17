/** The log (D-44, `!`): every notice this session gave, newest first, mono.
 * A read-only popover — recovery verbs live in their own toast, banner, or
 * dialog; the log only ever names what already happened. */
import { el } from "./renderer-dom.js";
import type { RendererActions, RendererState } from "./renderer-model.js";

function logTime(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function renderLogPopover(state: RendererState, actions: RendererActions): HTMLElement {
  const outer = el("div", "popover log");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Log");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card log-card");
  card.append(el("h2", "popover-title", "Log"));
  const list = el("div", "log-list");
  if (state.log.length === 0) {
    list.append(el("p", "empty-copy", "Nothing has happened yet this session."));
  } else {
    for (const entry of [...state.log].reverse()) {
      list.append(el("article", `log-row log-row-${entry.kind}`,
        el("span", "log-row-time", logTime(entry.at)),
        el("span", "log-row-text", entry.text)
      ));
    }
  }
  card.append(list);
  outer.append(card);
  return outer;
}
