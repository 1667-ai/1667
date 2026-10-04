import { useEffect, useMemo, useRef, useState } from "react";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../../../shared/generation-record.js";
import {
  adjustmentNotices,
  generationRecordFieldText,
  generationRecordKindLabel,
  generationRecordOperationLabel,
  generationRecordPipelineRows,
  humanEditWarning,
  pipelineCharacterCount
} from "../../../shared/generation-record-pipeline.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { errorMessage } from "../app/toasts.js";
import { Icon, ICONS } from "../ui/icons.js";
import { InspectChrome } from "./InspectPage.js";
import { useInspectKeys } from "./keys.js";
import { RequestDocument, type DocMessage, type DocSection } from "./RequestDocument.js";

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly summaries: readonly GenerationRecordSummary[] }
  | { readonly status: "error"; readonly message: string };

type DetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly recordId: string }
  | { readonly status: "ready"; readonly recordId: string; readonly detail: ResolvedGenerationRecord }
  | { readonly status: "error"; readonly recordId: string; readonly message: string };

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The generation records of one take (`h` in the TUI): every captured request
 * that produced or changed it. The events are listed, and the chosen one is
 * read as a request document: its settings, any adjustments, and the entries
 * of its prompt in the order they were sent.
 */
export function RecordViewer(
  { storyId, payload, nodeId, onOpenSidebar, onClose }: {
    readonly storyId: string;
    readonly payload: StoryPayload;
    readonly nodeId: string;
    readonly onOpenSidebar: () => void;
    readonly onClose: () => void;
  }
) {
  const { store } = useAppContext();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [eventIndex, setEventIndex] = useState(0);
  const [entryIndex, setEntryIndex] = useState(0);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  // A record is immutable, so one that was read stays read while the page is open.
  const cache = useRef(new Map<string, ResolvedGenerationRecord>());

  useEffect(() => {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return;
    let current = true;
    cache.current = new Map();
    setList({ status: "loading" });
    setDetail({ status: "idle" });
    void connection.api.getGenerationRecords(storyId, nodeId).then(
      (summaries) => {
        if (!current) return;
        setList({ status: "ready", summaries });
        setEventIndex(Math.max(0, summaries.length - 1));
        setEntryIndex(0);
      },
      (error: unknown) => {
        if (current) setList({ status: "error", message: errorMessage(error) });
      }
    );
    return () => { current = false; };
  }, [store, storyId, nodeId]);

  const summary = list.status === "ready" ? list.summaries[eventIndex] ?? null : null;
  const recordId = summary?.id ?? null;
  useEffect(() => {
    if (recordId === null) return;
    const cached = cache.current.get(recordId);
    if (cached !== undefined) {
      setDetail({ status: "ready", recordId, detail: cached });
      return;
    }
    const connection = store.get().connection;
    if (connection.kind !== "connected") return;
    let current = true;
    setDetail({ status: "loading", recordId });
    void connection.api.getGenerationRecord(storyId, nodeId, recordId).then(
      (resolved) => {
        cache.current.set(recordId, resolved);
        if (current) setDetail({ status: "ready", recordId, detail: resolved });
      },
      (error: unknown) => {
        if (current) setDetail({ status: "error", recordId, message: errorMessage(error) });
      }
    );
    return () => { current = false; };
  }, [store, storyId, nodeId, recordId]);

  const resolved = detail.status === "ready" ? detail.detail : null;
  const node = payload.path.find((candidate) => candidate.id === nodeId) ?? payload.nodes.find((candidate) => candidate.id === nodeId);
  const rows = useMemo(() => (resolved === null ? [] : generationRecordPipelineRows(resolved)), [resolved]);
  const document = useMemo(() => {
    if (resolved === null) return null;
    const messages: DocMessage[] = rows.map((row) => ({
      key: `${resolved.createdAt}:${row.index}`,
      role: row.role,
      label: row.label.slice(row.role.length + 3),
      content: row.content
    }));
    const warning = humanEditWarning(node);
    const onLine = payload.path.find((candidate) => candidate.id === nodeId);
    // Only an event that names its own characters can show them: without a
    // range the take's current text may hold later appends or rewrites.
    const output = onLine !== undefined && warning === null && resolved.range !== undefined
      ? onLine.text.slice(resolved.range.start, resolved.range.end)
      : null;
    if (output !== null && output.length > 0) {
      messages.push({ key: "output", role: "assistant", label: `output · characters ${resolved.range!.start}–${resolved.range!.end}`, content: output });
    }
    const sections: DocSection[] = [
      { label: "Human edit", lines: warning === null ? [] : [warning] },
      { label: "Effective settings", lines: [`wire protocol ${resolved.effective.wireProtocol}`, ...resolved.effective.fields.map(generationRecordFieldText)] },
      { label: "Construction adjustments", lines: adjustmentNotices(resolved.effective.adjustments, "construction") },
      { label: "Retry adjustments", lines: adjustmentNotices(resolved.effective.adjustments, "retry") },
      ...(resolved.kind === "unsupported" ? [{ label: "Unsupported", lines: [resolved.unsupportedReason ?? "This record could not be captured."] }] : [])
    ].filter((section) => section.lines.length > 0);
    return { messages, sections };
  }, [resolved, rows, node, payload, nodeId]);

  const messageCount = document?.messages.length ?? 0;
  const events = list.status === "ready" ? list.summaries.length : 0;
  const entry = Math.max(0, Math.min(Math.max(0, messageCount - 1), entryIndex));

  const selectEvent = (index: number): void => {
    const next = Math.max(0, Math.min(events - 1, index));
    if (next === eventIndex) return;
    setEventIndex(next);
    setEntryIndex(0);
  };

  useInspectKeys(onClose, (action) => {
    if (action === "left") selectEvent(eventIndex - 1);
    else if (action === "right") selectEvent(eventIndex + 1);
    else if (action === "up") setEntryIndex(Math.max(0, entry - 1));
    else if (action === "down") setEntryIndex(Math.min(Math.max(0, messageCount - 1), entry + 1));
    else if (action === "top") setEntryIndex(0);
    else if (action === "end") setEntryIndex(Math.max(0, messageCount - 1));
    else return false;
    return true;
  });

  const characters = resolved === null ? 0 : pipelineCharacterCount(resolved);
  const position = list.status === "loading" ? "loading…" : list.status === "error" ? "list failed" : events === 0 ? "no events" : `event ${eventIndex + 1}/${events}`;

  let body;
  if (list.status === "loading") body = <p className="story-empty">Loading this take's generation records…</p>;
  else if (list.status === "error") body = <p className="story-empty">Could not load this take's generation records. {list.message}</p>;
  else if (events === 0) body = <p className="story-empty">This take has no generation records.</p>;
  else {
    body = (
      <>
        <div className="record-events">
          <button type="button" className="icon-btn" title="Previous event (←)" aria-label="Previous event (←)" disabled={eventIndex === 0} onClick={() => selectEvent(eventIndex - 1)}>
            <Icon path={ICONS.chevronLeft} />
          </button>
          <ol className="record-event-list" aria-label="Events">
            {list.summaries.map((item, index) => (
              <li key={item.id}>
                <button type="button" className="record-event" aria-current={index === eventIndex ? "true" : undefined} onClick={() => selectEvent(index)}>
                  <span>{generationRecordKindLabel(item.kind)}</span>
                  <span className="record-event-time">{when(item.createdAt)}</span>
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="icon-btn" title="Next event (→)" aria-label="Next event (→)" disabled={eventIndex >= events - 1} onClick={() => selectEvent(eventIndex + 1)}>
            <Icon path={ICONS.chevronRight} />
          </button>
        </div>
        {resolved !== null && summary !== null && (
          <>
            <p className="request-route">
              {`kind ${generationRecordKindLabel(summary.kind)} · operation ${generationRecordOperationLabel(resolved.prompt.operation)} · created ${when(summary.createdAt)}`}
            </p>
            <p className="request-route">
              {`provider ${resolved.provider.provider} · model ${resolved.provider.model}`
                + (resolved.range === undefined ? "" : ` · range [${resolved.range.start}, ${resolved.range.end})`)
                + ` · ${rows.length} ${rows.length === 1 ? "entry" : "entries"} · ${characters.toLocaleString("en-US")} chars stored`}
            </p>
          </>
        )}
        {detail.status === "loading" && <p className="story-empty">Loading this event's generation record…</p>}
        {detail.status === "error" && <p className="story-empty">Could not load this generation record. {detail.message}</p>}
        {document !== null && (
          <RequestDocument
            label="Prompt entries"
            sections={document.sections}
            messages={document.messages}
            selected={entry}
            onSelect={setEntryIndex}
            empty="No prompt messages."
          />
        )}
      </>
    );
  }

  return (
    <InspectChrome storyTitle={payload.title} title="Generation records" detail={position} onOpenSidebar={onOpenSidebar} onClose={onClose}>
      {body}
    </InspectChrome>
  );
}
