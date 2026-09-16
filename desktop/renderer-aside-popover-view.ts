/** Aside popped out (2e, D-05): the inspector's Aside section (⇱) opens as
 * `div.popover.aside-popover`, 560 wide — the hop strip (D-27) at full width,
 * then the turns, then the question field. `esc` docks it back to the
 * inspector (`RendererKeysController`'s normal popover peel already handles
 * that). The section and the popover read the same `state.aside`; this file
 * only adds the popped-out chrome (header, hop strip, per-turn "Use…"). */
import type { AsidePresenceAnchorResponse } from "../shared/aside-transport.js";
import type { AsideAnchorView, AsideSessionAnchor } from "../tui/src/aside-surface.js";
import { actionButton, bindDraftInput, el } from "./renderer-dom.js";
import { expandInspectorSection } from "./renderer-inspector-view.js";
import {
  asideHopEntries,
  asideHopStripLayout,
  UNANCHORED_ASIDE_ID,
  type AsideHopStripSegment
} from "./renderer-aside-hop.js";
import {
  ASIDE_CURRENT_KEY,
  ASIDE_UNANCHORED_KEY,
  asideAnchorKey,
  type AsideState,
  type RendererActions,
  type RendererState
} from "./renderer-model.js";

const HOP_STRIP_WIDTH = 76;

/** `AsideAnchorView[]` built from `state.aside.anchors`
 * (`AsidePresenceAnchorResponse[]`), the same projection
 * `tui/src/aside-v2-settlement.ts`'s `reconcileAsidePresence` makes for the
 * TUI's own hop strip, plus the synthetic unanchored entry it appends when
 * `unanchoredCount > 0`. */
function anchorViewsFor(aside: AsideState): { readonly anchors: AsideAnchorView[]; readonly current: AsideSessionAnchor | null } {
  const anchors: AsideAnchorView[] = aside.anchors.map((entry: AsidePresenceAnchorResponse) => ({
    partId: entry.partId,
    takeId: entry.takeId,
    sessionCount: entry.sessionCount,
    ...(entry.partNumber === undefined ? {} : { partNumber: entry.partNumber }),
    ...(entry.takeIndex === undefined ? {} : { takeIndex: entry.takeIndex }),
    ...(entry.takeCount === undefined ? {} : { takeCount: entry.takeCount })
  }));
  if (aside.unanchoredCount > 0) {
    anchors.push({ partId: UNANCHORED_ASIDE_ID, takeId: UNANCHORED_ASIDE_ID, sessionCount: aside.unanchoredCount, unanchored: true });
  }
  return { anchors, current: aside.anchor };
}

/** The exact segments the hop strip renders for `aside`, at `width` cells —
 * exported for the contract test (`desktop-aside-hop-layout.test.ts`), which
 * checks this against `asideHopStripLayout` called directly on a fixture. */
export function hopStripSegments(aside: AsideState, width = HOP_STRIP_WIDTH): readonly AsideHopStripSegment[] {
  const { anchors, current } = anchorViewsFor(aside);
  return asideHopStripLayout(anchors, current, width).segments;
}

function keyForEntrySegment(segment: AsideHopStripSegment): string | null {
  const anchor = segment.entry?.anchor;
  if (anchor === undefined) return null;
  if (anchor.unanchored === true) return ASIDE_UNANCHORED_KEY;
  return asideAnchorKey(anchor);
}

function renderHopStrip(state: RendererState, actions: RendererActions): HTMLElement {
  const strip = el("div", "hop-strip");
  for (const segment of hopStripSegments(state.aside)) {
    if (segment.entry === undefined) {
      strip.append(el("span", "hop-strip-chrome", segment.text));
      continue;
    }
    const key = keyForEntrySegment(segment);
    const button = actionButton(`hop-strip-entry${segment.entry.current ? " current" : ""}`, segment.text, () => {
      if (key !== null) void actions.selectAsideAnchor(key);
    });
    strip.append(button);
  }
  return strip;
}

/** `¶ n · take j/k`, preferring the presence anchor's own display ordinals
 * (they cover a historical anchor off the active line) and falling back to
 * the live story path for the current position. */
function anchorMeta(state: RendererState): string {
  const anchor = state.aside.anchor;
  if (anchor === null) return "unanchored";
  const presence = state.aside.anchors.find((candidate) => candidate.partId === anchor.partId && candidate.takeId === anchor.takeId);
  if (presence?.partNumber !== undefined) {
    const take = presence.takeIndex === undefined || presence.takeCount === undefined ? "" : ` · take ${presence.takeIndex}/${presence.takeCount}`;
    return `¶ ${presence.partNumber}${take}`;
  }
  const story = state.story;
  if (story !== null) {
    const index = story.path.findIndex((node) => node.id === anchor.partId);
    if (index !== -1) {
      const node = story.path[index]!;
      const siblings = story.nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.role !== "summary");
      const takeIndex = siblings.findIndex((candidate) => candidate.id === node.id);
      const take = siblings.length > 1 && takeIndex !== -1 ? ` · take ${takeIndex + 1}/${siblings.length}` : "";
      return `¶ ${index + 1}${take}`;
    }
  }
  return "¶ ?";
}

function renderHeader(state: RendererState, actions: RendererActions): HTMLElement {
  const session = state.aside.sessions.find((candidate) => candidate.id === state.aside.selectedSessionId);
  const sessionIndex = session === undefined ? -1 : state.aside.sessions.indexOf(session);
  const sessionMeta = state.aside.sessions.length === 0
    ? ""
    : ` · session ${sessionIndex === -1 ? "–" : sessionIndex + 1} of ${state.aside.sessions.length}`;
  const title = session === undefined || session.title.trim().length === 0 ? "" : ` · "${session.title}"`;
  const line = el("p", "aside-popover-meta", `${anchorMeta(state)}${sessionMeta}${title}`);

  const anchorPicker = document.createElement("select");
  anchorPicker.className = "aside-anchor-picker";
  anchorPicker.setAttribute("aria-label", "Aside history");
  const currentLeaf = state.story?.path.at(-1);
  const currentAnchor = currentLeaf === undefined ? null : { partId: currentLeaf.id, takeId: currentLeaf.id };
  const selectedKey = state.aside.anchor === null ? ASIDE_UNANCHORED_KEY : asideAnchorKey(state.aside.anchor);
  const currentKey = currentAnchor === null ? ASIDE_UNANCHORED_KEY : asideAnchorKey(currentAnchor);
  const options: Array<{ readonly key: string; readonly label: string }> = [];
  if (currentAnchor !== null || state.aside.unanchoredCount === 0) {
    options.push({ key: ASIDE_CURRENT_KEY, label: currentAnchor === null ? "Current story · unanchored" : "Current story position" });
  }
  for (const anchor of state.aside.anchors) {
    const key = asideAnchorKey(anchor);
    if (currentAnchor !== null && key === currentKey) continue;
    const part = anchor.partNumber === undefined ? anchor.partId.slice(0, 8) : String(anchor.partNumber);
    options.push({ key, label: `¶ ${part} · ${anchor.sessionCount} session${anchor.sessionCount === 1 ? "" : "s"}` });
  }
  if (state.aside.unanchoredCount > 0) options.push({ key: ASIDE_UNANCHORED_KEY, label: `Unanchored · ${state.aside.unanchoredCount}` });
  for (const entry of options) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    option.selected = entry.key === ASIDE_CURRENT_KEY ? selectedKey === currentKey : entry.key === selectedKey;
    anchorPicker.append(option);
  }
  anchorPicker.addEventListener("change", () => void actions.selectAsideAnchor(anchorPicker.value));

  const header = el("header", "aside-popover-header",
    el("div", "aside-popover-title-row", el("span", "eyebrow", "Aside"), line),
    el("div", "aside-popover-actions",
      el("label", "aside-anchor-label", "History", anchorPicker),
      actionButton("aside-new-session", "New session", () => actions.selectAsideSession("")),
      actionButton("aside-dock", "⇲ dock", actions.closePopover)
    )
  );
  return header;
}

function renderTurnUseMenu(actions: RendererActions, answer: string): HTMLElement {
  const details = document.createElement("details");
  details.className = "aside-turn-use";
  details.append(
    el("summary", "", "Use…"),
    el("div", "aside-turn-use-menu",
      actionButton("aside-use-note", "Use as author's note", () => {
        // Stage it (review-fixes-2 #13) rather than persisting straight over
        // whatever note is already saved: the writer still has to press Save
        // note to keep it, exactly like typing the answer in by hand.
        actions.setDraft("authors-note", answer);
        expandInspectorSection("authors-note");
        document.querySelector<HTMLElement>('[data-inspector-section="authors-note"]')?.scrollIntoView({ block: "nearest" });
        actions.closePopover();
        actions.toast("Answer placed in the Author's Note · Save note keeps it");
      }),
      actionButton("aside-use-insert", "Insert into story…", () => actions.writeManual(answer)),
      actionButton("aside-use-copy", "Copy", () => { void navigator.clipboard.writeText(answer).then(() => actions.toast("Answer copied")).catch(() => actions.toast("Copy failed")); })
    )
  );
  return details;
}

/** Same rule `renderAsideSessions` (the docked inspector) uses: the live
 * answer shows while a turn is streaming, or once it stops/is retained but
 * has not yet landed as the session's own last turn. */
function renderLiveAnswer(state: RendererState): HTMLElement | null {
  const session = state.aside.sessions.find((candidate) => candidate.id === state.aside.selectedSessionId);
  const lastAnswer = session?.turns.at(-1)?.a;
  if (state.aside.answer.length === 0 || (!state.aside.busy && state.aside.answer === lastAnswer)) return null;
  return el("p", "aside-answer aside-live-answer", state.aside.answer);
}

function renderTurns(state: RendererState, actions: RendererActions): HTMLElement {
  const session = state.aside.sessions.find((candidate) => candidate.id === state.aside.selectedSessionId);
  const list = el("div", "aside-turns");
  const live = renderLiveAnswer(state);
  if (live !== null) list.append(live);
  if (session === undefined) {
    list.append(el("p", "aside-history", "No saved session at this story position yet."));
    return list;
  }
  session.turns.forEach((turn, index) => {
    const row = el("article", "aside-turn");
    row.append(el("p", "aside-question-line", turn.q));
    if (turn.thoughts !== undefined && turn.thoughts.trim().length > 0) {
      const thoughts = document.createElement("details");
      thoughts.className = "aside-turn-thoughts";
      thoughts.append(el("summary", "", "thinking"), el("p", "", turn.thoughts));
      row.append(thoughts);
    }
    row.append(el("p", "aside-answer", turn.a));
    const controls = el("div", "aside-turn-controls");
    if (index === session.turns.length - 1) controls.append(actionButton("aside-retake", "Retake", () => actions.retakeAside(index)));
    controls.append(renderTurnUseMenu(actions, turn.a));
    row.append(controls);
    list.append(row);
  });
  return list;
}

function renderQuestionRow(state: RendererState, actions: RendererActions): HTMLElement {
  // A unique `data-preserve` key, not the docked inspector's `.aside-question`
  // one: `render()`'s focus restore takes the first DOM match for a key, and
  // the docked field is still in the document (hidden behind this popover),
  // so sharing the key would restore focus there instead of here — or, with
  // no key at all, restore it nowhere, dropping focus to the document on the
  // next full render and letting the next keystroke run a NAV command
  // instead of typing. The draft VALUE still comes from the shared
  // "aside-question" key so both fields show the same text.
  const question = document.createElement("textarea");
  question.className = "aside-question";
  question.dataset.preserve = "aside-question-popover";
  question.value = state.drafts["aside-question"] ?? state.aside.question;
  question.placeholder = "Ask about the manuscript…";
  question.rows = 3;
  bindDraftInput(question, () => actions.setDraft("aside-question", question.value));
  const ask = state.aside.busy
    ? actionButton("aside-stop", "Stop", actions.stopAside)
    : actionButton("aside-ask", "Ask ⌘↵", () => actions.askAside(question.value));
  question.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      ask.click();
    }
  });
  const footer = el("div", "aside-popover-footer-row",
    el("span", "aside-popover-hint", "utility route"),
    ask
  );
  return el("div", "aside-popover-question", question, footer);
}

/** `g` (popover open, no field focused, per the footer hint) goes to the
 * take of the current hop — `null` when the current hop is the unanchored
 * bucket, which names no single take. */
export function currentAsideHopTakeId(aside: AsideState): string | null {
  const { anchors, current } = anchorViewsFor(aside);
  const entry = asideHopEntries(anchors, current).find((candidate) => candidate.current);
  if (entry === undefined || entry.anchor.unanchored === true) return null;
  return entry.anchor.takeId;
}

export function renderAsidePopover(state: RendererState, actions: RendererActions): HTMLElement {
  const outer = el("div", "popover aside-popover");
  outer.setAttribute("role", "dialog");
  outer.setAttribute("aria-label", "Aside");
  outer.addEventListener("click", (event) => { if (event.target === outer) actions.closePopover(); });
  const card = el("div", "popover-card aside-popover-card",
    renderHeader(state, actions),
    renderHopStrip(state, actions),
    renderTurns(state, actions),
    renderQuestionRow(state, actions),
    el("p", "hint-row", "click a position to hop · g goes to its take · never enters a write prompt")
  );
  outer.append(card);
  return outer;
}
