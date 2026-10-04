import { useEffect, useState } from "react";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { findingRows, runSummary, type FindingRow } from "./model.js";

const STATUS_LABEL = { current: "", "off-line": "Other line", stale: "Out of date" } as const;

/** The panel's Findings view: one row per contradiction the last Fact check
 * found, with the Fact's name, the quote and what contradicts. The keys (↑↓,
 * Enter) are handled by `StoryPanel`, which owns the keyboard. */
export function FindingsPanel(
  { payload, cursor, onCursor }: {
    readonly payload: StoryPayload;
    readonly cursor: number;
    readonly onCursor: (index: number) => void;
  }
) {
  const { store, actions } = useAppContext();
  const findings = useStore(store, (state) => state.factCheck.findings);
  const [selectedRow, setSelectedRow] = useState<HTMLElement | null>(null);
  useEffect(() => { selectedRow?.scrollIntoView({ block: "nearest" }); }, [selectedRow, cursor]);

  if (findings === null || findings.storyId !== payload.id) {
    return <p className="panel-empty">No Fact check yet. Use the palette (:) to check a chapter or the story line.</p>;
  }
  const rows = findingRows(findings.run, payload);
  return (
    <div className="findings-view">
      <p className="findings-summary">
        {rows.length === 0 ? "No contradictions found" : `${rows.length} ${rows.length === 1 ? "contradiction" : "contradictions"}`}
        {" · "}{runSummary(findings.run)}
      </p>
      <ol className="panel-list" aria-label="Findings">
        {rows.map((row: FindingRow, index) => {
          const selected = index === cursor;
          return (
            <li
              key={row.key}
              ref={selected ? setSelectedRow : undefined}
              className={`panel-row finding-row${selected ? " selected" : ""}${row.status === "current" ? "" : " dimmed"}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                onCursor(index);
                actions.factCheck.select(row);
              }}
            >
              <div className="panel-row-main">
                <span className="panel-row-title">{row.factName}</span>
                <q className="finding-quote">{row.quote}</q>
                <span className="finding-statement">{row.statement}</span>
                <span className="panel-row-meta">
                  {row.partNumber === null ? "Not on this line" : `Part ${row.partNumber}`}
                  {row.status === "current" ? "" : ` · ${STATUS_LABEL[row.status]}`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
