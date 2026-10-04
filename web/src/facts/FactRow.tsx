import type { Ref } from "react";
import { factBody, factName, factPathProjection, factPriorityGlyph, factScopeLabel } from "../../../shared/fact-view.js";
import { factStatusForPath } from "../../../shared/facts-model.js";
import type { StoryFact, StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { factStatusLabel, useRequestEstimate } from "../context/status.js";
import { Icon, ICONS } from "../ui/icons.js";

/** One fact in the list: name, a line of body, and where it applies. The
 * selected row also shows the reorder buttons. */
export function FactRow(
  { fact, payload, selected, rowRef, reorderable, first, last, onSelect }: {
    readonly fact: StoryFact;
    readonly payload: StoryPayload;
    readonly selected: boolean;
    readonly rowRef?: Ref<HTMLLIElement> | undefined;
    /** False while a filter hides some facts: "up" would not mean "earlier". */
    readonly reorderable: boolean;
    readonly first: boolean;
    readonly last: boolean;
    readonly onSelect: () => void;
  }
) {
  const { store, actions } = useAppContext();
  const picking = useStore(store, (state) => state.facts.pick !== null);
  const pathIds = payload.path.map((node) => node.id);
  const projection = factPathProjection(fact, pathIds);
  const scope = factScopeLabel(fact, pathIds, [], projection);
  const glyph = factPriorityGlyph(fact.priority);
  const body = factBody(fact, pathIds, projection);
  const estimate = useRequestEstimate(payload.id);
  const requestStatus = estimate === null
    ? null
    : factStatusLabel(factStatusForPath(fact, estimate.factStatuses.get(fact.id) ?? { kind: "not-matched" }, pathIds, projection));

  return (
    <li
      ref={rowRef}
      className={`panel-row fact-row${selected ? " selected" : ""}${projection.scope === "elsewhere" || projection.scope === "ended" ? " dormant" : ""}`}
      aria-current={selected ? "true" : undefined}
      data-fact-id={fact.id}
      onClick={() => { onSelect(); if (picking) void actions.facts.pickFact(fact.id); else actions.facts.open(fact.id); }}
    >
      <div className="panel-row-main">
        <span className="panel-row-title">{factName(fact, pathIds, projection)}</span>
        {body.length > 0 && <span className="fact-row-body">{body}</span>}
        <span className="panel-row-meta fact-row-meta">
          {fact.tag !== null && fact.tag.length > 0 && <span className="label-chip">{fact.tag}</span>}
          <span>{fact.activation === "keyed" ? "keyed" : "always"}</span>
          {glyph.length > 0 && <span title={glyph === "↑" ? "High priority" : "Low priority"}>{glyph}</span>}
          {scope !== "—" && <span className="fact-row-scope">{scope}</span>}
          {requestStatus !== null && <span className="fact-status" data-status={requestStatus.kind}>{requestStatus.text}</span>}
        </span>
      </div>
      {selected && (
        <div className="panel-row-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="icon-btn"
            title="Move up (Shift+↑)"
            aria-label="Move up (Shift+↑)"
            disabled={first || !reorderable}
            onClick={() => { onSelect(); void actions.facts.move(fact.id, -1); }}
          >
            <Icon path={ICONS.arrowUp} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Move down (Shift+↓)"
            aria-label="Move down (Shift+↓)"
            disabled={last || !reorderable}
            onClick={() => { onSelect(); void actions.facts.move(fact.id, 1); }}
          >
            <Icon path={ICONS.arrowDown} />
          </button>
        </div>
      )}
    </li>
  );
}
