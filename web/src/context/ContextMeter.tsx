import { useMemo } from "react";
import { factDropNotice } from "../../../shared/facts-model.js";
import {
  buildContextMeterModel,
  contextSeverity,
  formatTokensGraded,
  formatTokensScaled,
  requestWindow,
  tokenCountMark,
  type ContextMeterModel
} from "../../../shared/rail-model.js";
import { useAppContext } from "../app/context.js";
import { openSettings } from "../app/router.js";
import { useStore } from "../app/store.js";
import { usePopover } from "../ui/usePopover.js";
import { currentCount, type ProjectionSnapshot } from "./state.js";
import type { PromptTokenCount } from "../../../shared/tokenize-source.js";
import { IS_MAC } from "../app/platform.js";

const CATEGORIES = [
  ["voice", "Voice"],
  ["facts", "Facts"],
  ["recent", "Recent"],
  ["summary", "Summary"],
  ["note", "Note"],
  ["visual", "Images"]
] as const;

/** The model of the meter for one projection and its count. */
export function useContextMeterModel(storyId: string): ContextMeterModel | null {
  const { store } = useAppContext();
  const projection = useStore(store, (state) => (state.context.projection?.storyId === storyId ? state.context.projection : null));
  const answer = useStore(store, (state) => state.context.count);
  const count = answer !== null && projection !== null && answer.identity === projection.fingerprint ? answer.count : null;
  return useMemo(() => meterModel(projection, count), [projection, count]);
}

function meterModel(projection: ProjectionSnapshot | null, count: PromptTokenCount | null): ContextMeterModel | null {
  return projection === null
    ? null
    : buildContextMeterModel(projection.estimate, projection.contextWindow, projection.growthTokens, projection.maxOutputTokens, count);
}

/** The exact figure, marked by how well it was counted. */
function figure(tokens: number, model: ContextMeterModel): string {
  return `${tokenCountMark(model.perMessageGrade)}${Math.max(0, tokens).toLocaleString("en-US")}`;
}

function valueText(model: ContextMeterModel): string {
  const used = formatTokensGraded(model.contextTokens, model.totalGrade);
  return model.window === null ? `${used} tokens` : `${used} / ${formatTokensScaled(model.window.size)}`;
}

/**
 * The context meter (#409 step 10f), the TUI rail's footer: "next request ~N /
 * window" collapsed, and the voice / facts / recent / summary / note breakdown
 * when opened (click, or ⌃G on a Mac). It reads the shared projection; it
 * never computes one.
 */
export function ContextMeter({ storyId }: { readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const model = useContextMeterModel(storyId);
  const expanded = useStore(store, (state) => state.context.expanded);
  const popover = usePopover({ open: expanded, setOpen: actions.context.setExpanded });
  if (model === null) return null;

  const window = requestWindow(model.contextTokens + model.growthTokens, model.window?.size ?? null);
  const severity = contextSeverity(window);
  const fill = model.window === null ? 0 : Math.min(1, model.window.fill);
  const dropNotice = factDropNotice(model.droppedFacts);
  const total = model.window === null ? Math.max(1, model.contextTokens) : model.window.size;
  const shortcut = IS_MAC ? " (⌃G)" : "";

  return (
    <div className="context-meter" ref={popover.containerRef} data-severity={severity}>
      <button
        type="button"
        className="context-meter-button"
        aria-expanded={expanded}
        aria-controls="context-meter-detail"
        title={`Next request: what the model will read${shortcut}`}
        {...IS_MAC ? { "aria-keyshortcuts": "Control+G" } : {}}
        onClick={actions.context.toggleExpanded}
      >
        <span className="context-meter-label">next request</span>
        <span className="context-meter-value">{valueText(model)}</span>
        {model.window !== null && (
          <span className="context-gauge" aria-hidden="true">
            <span className="context-gauge-fill" style={{ width: `${Math.max(2, Math.round(fill * 100))}%` }} />
          </span>
        )}
      </button>
      {expanded && (
        <section id="context-meter-detail" className="context-detail" aria-label="Next request context">
          <header className="context-detail-head">
            <span className="context-detail-title">Context</span>
            <span className="context-detail-sub">request + response</span>
          </header>
          <div className="context-bar" aria-hidden="true">
            {CATEGORIES.map(([key]) => (
              model.breakdown[key] > 0
                ? <span key={key} className={`context-slice cat-${key}`} style={{ width: `${(model.breakdown[key] / total) * 100}%` }} />
                : null
            ))}
          </div>
          <ul className="context-legend" aria-label="Context breakdown">
            {CATEGORIES.map(([key, label]) => (
              (key === "note" || key === "visual") && model.breakdown[key] === 0
                ? null
                : (
                  <li key={key} className="context-legend-row">
                    <span className={`context-swatch cat-${key}`} aria-hidden="true" />
                    <span className="context-legend-label">{label}</span>
                    <span className="context-legend-count">{figure(model.breakdown[key], model)}</span>
                  </li>
                )
            ))}
          </ul>
          <p className="context-total">
            <span>Total</span>
            <span className="context-total-value">{figure(model.contextTokens, model)}</span>
          </p>
          {model.window === null
            ? (
              <button
                type="button"
                className="btn btn-ghost btn-small context-hint"
                title="Open settings (,)"
                onClick={() => { actions.context.setExpanded(false); openSettings(); }}
              >
                set context window · settings
              </button>
            )
            : (
              <p className="context-window-line">
                {model.window.over > 0 ? `over by ${formatTokensScaled(model.window.over)}` : `${formatTokensScaled(model.window.free)} free`}
                {" of "}{formatTokensScaled(model.window.size)}
                {model.growthTokens > 0 && ` · response +~${formatTokensScaled(model.growthTokens)}`}
              </p>
            )}
          {severity === "over" && <p className="context-note context-note-danger">summarize or drop a fact</p>}
          {dropNotice !== null && <p className="context-note context-note-warn">{dropNotice}</p>}
          {model.chapterNotice !== null && <p className="context-note">{model.chapterNotice}</p>}
        </section>
      )}
    </div>
  );
}
