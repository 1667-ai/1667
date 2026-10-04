import { useEffect, useRef, useState } from "react";
import type { TokenProbabilityRecord } from "../../../shared/token-probabilities.js";
import {
  resolveTokenProbabilityEmptyReason,
  tokenDisplayGlyph,
  tokenProbabilityAlternativeRows,
  tokenProbabilitySpan,
  type TokenProbabilityEmptyReason
} from "../../../shared/token-probabilities-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { navigate } from "../app/router.js";
import { Icon, ICONS } from "../ui/icons.js";
import { InspectChrome } from "./InspectPage.js";
import { useInspectKeys } from "./keys.js";

type RecordState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly record: TokenProbabilityRecord }
  | { readonly status: "empty"; readonly reason: TokenProbabilityEmptyReason };

function percent(p: number): string {
  return `${(p * 100).toFixed(p >= 0.1 ? 1 : 2)}%`;
}

/**
 * The token probabilities of one take (`l` in the TUI): its prose with one
 * token marked, and the alternatives the model weighed at that position.
 * ←→ move between tokens, ↑↓ between alternatives, and Tab goes to the next
 * part. A take that has none says why, in the TUI's own words.
 */
export function ProbsViewer(
  { storyId, payload, nodeId, onOpenSidebar, onClose }: {
    readonly storyId: string;
    readonly payload: StoryPayload;
    readonly nodeId: string;
    readonly onOpenSidebar: () => void;
    readonly onClose: () => void;
  }
) {
  const { store } = useAppContext();
  const [state, setState] = useState<RecordState>({ status: "loading" });
  const [tokenIndex, setTokenIndex] = useState(0);
  const [altIndex, setAltIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const markRef = useRef<HTMLElement>(null);

  const part = payload.path.find((node) => node.id === nodeId) ?? null;
  const partIndex = part === null ? -1 : payload.path.indexOf(part);
  const hasRecord = part !== null && part.tokenProbabilities === true;

  useEffect(() => {
    setTokenIndex(0);
    setAltIndex(0);
    setExpanded(false);
    setState({ status: "loading" });
    const connection = store.get().connection;
    if (part === null || connection.kind !== "connected") return;
    let current = true;
    const explain = async (): Promise<TokenProbabilityEmptyReason> => {
      try {
        return resolveTokenProbabilityEmptyReason(await connection.api.getSettings());
      } catch {
        return { text: "This take has no token probabilities." };
      }
    };
    void (async () => {
      let record: TokenProbabilityRecord | null = null;
      if (hasRecord) {
        try {
          record = await connection.api.getTokenProbabilities(storyId, nodeId);
        } catch {
          // The part said it had one; a failure here is a race (pruned, or
          // not written) and falls back to the same words an absent one gets.
          record = null;
        }
      }
      const next: RecordState = record !== null && record.steps.length > 0
        ? { status: "ready", record }
        : { status: "empty", reason: await explain() };
      if (current) setState(next);
    })();
    return () => { current = false; };
  }, [store, storyId, nodeId, hasRecord, part === null]);

  const record = state.status === "ready" ? state.record : null;
  const total = record?.steps.length ?? 0;
  const step = record?.steps[tokenIndex];
  const rows = step === undefined ? [] : tokenProbabilityAlternativeRows(step, expanded);

  const moveToken = (delta: -1 | 1): void => {
    if (total === 0) return;
    const next = Math.max(0, Math.min(total - 1, tokenIndex + delta));
    if (next === tokenIndex) return;
    setTokenIndex(next);
    // Each token starts its own, freshly collapsed list.
    setAltIndex(0);
    setExpanded(false);
  };
  const moveAlternative = (delta: -1 | 1): void => {
    if (rows.length === 0) return;
    if (delta > 0 && !expanded && rows[altIndex]?.kind === "collapsed") {
      // The summary row is replaced in place by the alternatives it stood for.
      setExpanded(true);
      return;
    }
    setAltIndex(Math.max(0, Math.min(rows.length - 1, altIndex + delta)));
  };
  /** False at the last part, so Tab moves focus the browser's way. */
  const nextPart = (): boolean => {
    const next = partIndex < 0 ? undefined : payload.path[partIndex + 1];
    if (next === undefined) return false;
    navigate({ kind: "story", id: storyId, page: { kind: "probs", nodeId: next.id } }, { replace: true });
    return true;
  };

  useInspectKeys(onClose, (action) => {
    if (action === "left") moveToken(-1);
    else if (action === "right") moveToken(1);
    else if (action === "up") moveAlternative(-1);
    else if (action === "down") moveAlternative(1);
    else if (action === "next") return nextPart();
    else return false;
    return true;
  });

  useEffect(() => { markRef.current?.scrollIntoView({ block: "center" }); }, [tokenIndex, state]);

  let body;
  if (part === null) body = <p className="story-empty">This take is no longer part of the story.</p>;
  else if (state.status === "loading") body = <p className="story-empty">Loading token probabilities…</p>;
  else if (state.status === "empty") {
    body = (
      <div className="probs-empty">
        <p>{state.reason.text}</p>
        {state.reason.supportedPresets !== undefined && state.reason.supportedPresets.length > 0 && (
          <p className="request-route">presets that do support it: {state.reason.supportedPresets.join(", ")}</p>
        )}
      </div>
    );
  } else if (record !== null && step !== undefined) {
    const span = tokenProbabilitySpan(record, tokenIndex);
    body = (
      <>
        <p className="probs-text" aria-label="Take text">
          {part.text.slice(0, span.start)}
          <mark ref={markRef} className="probs-mark" aria-label={`Token ${tokenIndex + 1}`}>{part.text.slice(span.start, span.end)}</mark>
          {part.text.slice(span.end)}
        </p>
        <section className="probs-alternatives" aria-label={`Alternatives for token ${tokenIndex + 1} of ${total}`}>
          <header className="probs-toolbar">
            <span className="probs-heading">alternatives · token {tokenIndex + 1} of {total}</span>
            <span className="probs-buttons">
              <button type="button" className="icon-btn" title="Previous token (←)" aria-label="Previous token (←)" disabled={tokenIndex === 0} onClick={() => moveToken(-1)}>
                <Icon path={ICONS.chevronLeft} />
              </button>
              <button type="button" className="icon-btn" title="Next token (→)" aria-label="Next token (→)" disabled={tokenIndex >= total - 1} onClick={() => moveToken(1)}>
                <Icon path={ICONS.chevronRight} />
              </button>
              <button type="button" className="btn btn-ghost btn-small" title="Next part (Tab)" disabled={partIndex < 0 || partIndex >= payload.path.length - 1} onClick={() => { nextPart(); }}>
                Next part
              </button>
            </span>
          </header>
          <ul className="probs-rows">
            {rows.map((row, index) => (
              row.kind === "collapsed"
                ? (
                  <li key="collapsed" className="probs-row probs-row-collapsed" aria-current={index === altIndex ? "true" : undefined}>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => { setExpanded(true); setAltIndex(index); }}>
                      {row.hiddenCount} more under 1%
                    </button>
                  </li>
                )
                : (
                  <li key={row.index} className="probs-row" aria-current={index === altIndex ? "true" : undefined} onClick={() => setAltIndex(index)}>
                    <span className="probs-token">{tokenDisplayGlyph(row.token)}</span>
                    <span className="probs-percent">{percent(row.p)}</span>
                    <span className="probs-bar" aria-hidden="true"><span style={{ width: `${Math.max(1, Math.round(row.p * 100))}%` }} /></span>
                    <span className="probs-logprob">{row.logprob.toFixed(3)}</span>
                    {row.sampled && <span className="probs-sampled">✓ sampled</span>}
                  </li>
                )
            ))}
          </ul>
          {record.truncated === true && <p className="request-route">The recording stopped early: a bound was reached.</p>}
        </section>
      </>
    );
  }

  const crumb = part === null ? "" : `part ${partIndex + 1}${record === null ? "" : ` · logprobs · top ${record.requested}`}`;
  return (
    <InspectChrome storyTitle={payload.title} title="Token probabilities" detail={crumb} onOpenSidebar={onOpenSidebar} onClose={onClose}>
      {body}
    </InspectChrome>
  );
}
