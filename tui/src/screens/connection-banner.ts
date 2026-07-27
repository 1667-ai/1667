import { retrySeconds } from "../connection.js";
import type { FrameDeadlineCollector } from "../animation-deadline.js";
import { addHit } from "../hit.js";
import { overlayTextInputActive, textOwnsKeyboard } from "../keys.js";
import type { OverlayState, StoryScreenState } from "../state.js";
import { fitLine, visibleWidth, type FrameLine } from "./story/frame.js";

export function renderConnectionBanner(
  base: FrameLine[],
  state: OverlayState & Pick<StoryScreenState, "mode" | "tag"> & { now: number },
  width: number,
  deadlines?: FrameDeadlineCollector
): FrameLine[] {
  const seconds = retrySeconds(state.connection, state.now);
  if (state.connection.nextRetryAt !== null && state.connection.nextRetryAt > state.now) {
    deadlines?.at(state.connection.nextRetryAt - Math.max(0, seconds - 1) * 1_000);
  }
  const retrying = state.connection.nextRetryAt === null ? "retry paused" : `retrying in ${seconds}s`;
  const ownsText = textOwnsKeyboard(state.mode, {
    overlayTyping: overlayTextInputActive(state),
    commandsTags: state.commands?.view === "tags",
    tagChoosingStatus: state.tag?.choosingStatus ?? false
  });
  const retry = ownsText ? "retry now" : "R retries now";
  const attempts = `(attempt ${state.connection.attempt}/5)`;
  const candidates = [
    `▲ connection lost — ${retrying} ${attempts} · everything is saved on disk`,
    `▲ connection lost — ${retrying} ${attempts} · saved on disk`,
    `▲ connection lost — ${retrying} · saved on disk`,
    "▲ connection lost · saved on disk"
  ];
  const lead = candidates.find((candidate) => visibleWidth(`${candidate} · ${retry}`) <= width)
    ?? candidates.at(-1)!;
  const shownLead = `${lead} · `;
  const output = [...base];
  const banner = fitLine([
    { text: shownLead, role: "background", background: "danger", bold: true },
    { text: retry, role: "background", background: "danger", bold: true }
  ], width);
  for (const part of banner) {
    part.role = "background";
    part.background = "danger";
    part.bold = true;
  }
  output[0] = banner;
  if (state.hitRows[0]?.target.kind !== "scrim") {
    state.hitRows[0] = { target: { kind: "panel" }, left: 0, right: width };
  }
  const retryLeft = visibleWidth(shownLead);
  addHit(state.hitRows, 0, {
    target: { kind: "action", action: "retry" }, left: retryLeft, right: Math.min(width, retryLeft + visibleWidth(retry))
  });
  return output;
}
