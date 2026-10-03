import { useEffect, useRef, type RefObject } from "react";
import { FACT_SCOPE_FILTERS, factTags, type FactScopeFilter } from "../../../shared/fact-view.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { FactEditor } from "./FactEditor.js";
import { FactRow } from "./FactRow.js";
import { FactsBudget } from "./FactsBudget.js";
import { filterActive } from "./rows.js";

const SCOPE_LABELS: Readonly<Record<FactScopeFilter, string>> = {
  everywhere: "Everywhere",
  "this-line": "This line",
  elsewhere: "Elsewhere",
  ended: "Ended"
};

const SCOPE_HINTS: Readonly<Record<FactScopeFilter, string>> = {
  everywhere: "All facts",
  "this-line": "Facts with a state on this line",
  elsewhere: "Facts for another line",
  ended: "Facts that ended on this line"
};

/** The panel's Facts view: the list with its filters and budget, or the
 * editor when one is open. The keys (↑↓, Enter, n, e, /) are handled by
 * `StoryPanel`, which owns the keyboard; `cursor` is the selected row. */
export function FactsPanel(
  { payload, rows, cursor, onCursor, filterRef }: {
    readonly payload: StoryPayload;
    readonly rows: readonly StoryFact[];
    readonly cursor: number;
    readonly onCursor: (index: number) => void;
    readonly filterRef: RefObject<HTMLInputElement | null>;
  }
) {
  const { store, actions } = useAppContext();
  const filter = useStore(store, (state) => state.facts.filter);
  const editor = useStore(store, (state) => state.facts.editor);
  const pick = useStore(store, (state) => state.facts.pick);
  const selectedRow = useRef<HTMLLIElement | null>(null);

  useEffect(() => { selectedRow.current?.scrollIntoView({ block: "nearest" }); }, [cursor, rows.length]);

  if (editor !== null && editor.storyId === payload.id) return <FactEditor payload={payload} editor={editor} />;

  const reorderable = !filterActive(filter);
  const tags = factTags(payload.facts).filter((tag): tag is string => tag !== null);
  const pickPart = pick === null ? null : payload.path.findIndex((node) => node.id === pick.partId) + 1;

  return (
    <div className="facts-view">
      <div className="facts-head">
        <div className="facts-summary">
          <span className="facts-count">{payload.facts.length} {payload.facts.length === 1 ? "fact" : "facts"}</span>
          <FactsBudget payload={payload} />
        </div>
        <div className="facts-scopes" role="group" aria-label="Scope">
          {FACT_SCOPE_FILTERS.map((scope) => (
            <button
              key={scope}
              type="button"
              className="chip-btn"
              aria-pressed={filter.scope === scope}
              title={SCOPE_HINTS[scope]}
              onClick={() => actions.facts.setFilter({ scope })}
            >
              {SCOPE_LABELS[scope]}
            </button>
          ))}
        </div>
        {filter.anchorPartId !== null && (
          <div className="facts-scopes">
            <button
              type="button"
              className="chip-btn"
              aria-pressed="true"
              title="Show all facts again"
              onClick={() => actions.facts.setFilter({ anchorPartId: null })}
            >
              At part {payload.path.findIndex((node) => node.id === filter.anchorPartId) + 1} ×
            </button>
          </div>
        )}
        <div className="facts-filters">
          {tags.length > 0 && (
            <select
              className="facts-input facts-tag-select"
              aria-label="Tag"
              title="Filter by tag"
              value={filter.tag ?? ""}
              onChange={(event) => actions.facts.setFilter({ tag: event.target.value === "" ? null : event.target.value })}
            >
              <option value="">All tags</option>
              {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          )}
          <input
            ref={filterRef}
            className="facts-input"
            aria-label="Filter facts"
            placeholder="Filter (/)"
            value={filter.query}
            onChange={(event) => actions.facts.setFilter({ query: event.target.value })}
          />
        </div>
      </div>
      {pick !== null && (
        <div className="facts-pick" role="status">
          <span>
            {pick.action === "end" ? "Pick the fact that ends" : "Pick the fact for a new state"} at part {pickPart}.
          </span>
          <button type="button" className="btn btn-small btn-ghost" title="Cancel (Esc)" onClick={actions.facts.cancelPick}>Cancel</button>
        </div>
      )}
      {rows.length === 0
        ? (
          <p className="panel-empty">
            {payload.facts.length === 0 ? "No facts yet. Press n to add one." : "No facts match."}
          </p>
        )
        : (
          <ol className="panel-list" aria-label="Facts">
            {rows.map((fact, index) => (
              <FactRow
                key={fact.id}
                fact={fact}
                payload={payload}
                selected={index === cursor}
                rowRef={index === cursor ? selectedRow : undefined}
                reorderable={reorderable}
                first={index === 0}
                last={index === rows.length - 1}
                onSelect={() => onCursor(index)}
              />
            ))}
          </ol>
        )}
      <div className="panel-foot facts-foot">
        <button type="button" className="btn btn-small" title="New fact (n)" onClick={() => actions.facts.openNew()}>
          <Icon path={ICONS.plus} />
          New fact
        </button>
      </div>
    </div>
  );
}
