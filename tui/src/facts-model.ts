import type { FactActivation } from "../../shared/fact-metadata.js";
import type { FactActivationTrace } from "../../shared/fact-activation.js";
import type { FactRequestStatus } from "../../shared/facts-model.js";
import type { DisplayRole } from "./screens/story/frame.js";

// The pure Fact view helpers and the request status model live in `shared/`
// (the web UI uses them too).
export * from "../../shared/fact-view.js";
export * from "../../shared/facts-model.js";

/** One glyph, one word, and the role to paint them with \u2014 the single place
 *  that decides how a Fact's request status reads, shared by the Facts
 *  panel and the side rail so the two surfaces cannot say different things
 *  about the same Fact (see tui/src/screens/facts-panel.ts and
 *  tui/src/screens/story/facts-rail.ts). */
export interface FactStatusDisplay {
  readonly glyph: string;
  readonly word: string;
  readonly emphasis: DisplayRole;
}

export function factStatusDisplay(
  activation: FactActivation,
  status: FactRequestStatus,
  trace?: FactActivationTrace
): FactStatusDisplay {
  if (status.kind === "off-path") {
    return { glyph: "\u2298", word: "off-path", emphasis: "chrome" };
  }
  if (status.kind === "ended") {
    return { glyph: "\u2715", word: "ended", emphasis: "context warning" };
  }
  if (activation === "always") {
    // An `always` Fact has no "not matched" state \u2014 it always matches by
    // definition \u2014 so the only thing worth marking is a shed one.
    return status.kind === "dropped"
      ? { glyph: "\u2715", word: "always", emphasis: "context warning" }
      : { glyph: "", word: "always", emphasis: "focus / accent" };
  }
  switch (status.kind) {
    case "sent": return { glyph: "\u2713", word: trace?.round && trace.round > 0 ? "chain" : trace?.kind === "regex" ? "regex" : "keyed", emphasis: "focus / accent" };
    case "dropped": return { glyph: "\u2715", word: "keyed", emphasis: "context warning" };
    case "unevaluated": return { glyph: "\u26a0", word: "keyed", emphasis: "context warning" };
    case "not-matched": return { glyph: "\u00b7", word: "keyed", emphasis: "chrome" };
  }
}
