import type { MapAction, NodeDetail } from "./map-view-model.js";

const ACTION_LABEL: Record<MapAction, string> = {
  switch: "Switch line",
  go: "Go to part",
  unfold: "Unfold"
};

/** What the cursor's node is, and the one thing Enter does with it. */
export function MapFooter({ detail, busy, onAct }: {
  readonly detail: NodeDetail | null;
  readonly busy: boolean;
  readonly onAct: () => void;
}) {
  if (detail === null) return <footer className="map-footer" />;
  const facts: string[] = [];
  if (detail.cold !== null) {
    facts.push(`${detail.cold.lines} ${detail.cold.lines === 1 ? "line" : "lines"}`, `cold ${detail.cold.weeks} wks`);
  } else {
    facts.push(`Part ${detail.part}`, `${detail.words.toLocaleString()} words`, detail.age);
  }
  if (detail.take !== null) facts.push(`take ${detail.take.index} of ${detail.take.count}`);
  if (detail.below > 0) facts.push(`${detail.below} ${detail.below === 1 ? "part" : "parts"} below`);
  return (
    <footer className="map-footer">
      <div className="map-footer-text">
        {detail.name !== null && detail.cold === null && <span className="map-footer-name">{detail.name}</span>}
        <p className="map-footer-preview">{detail.preview}</p>
        <p className="map-footer-facts">{facts.join(" · ")}. {detail.place}</p>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-small"
        title={`${ACTION_LABEL[detail.action]} (Enter)`}
        disabled={busy}
        onClick={onAct}
      >
        {ACTION_LABEL[detail.action]}
      </button>
    </footer>
  );
}
