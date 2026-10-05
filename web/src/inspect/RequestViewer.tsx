import { useMemo, useState } from "react";
import {
  activationNotices,
  requestEntrySource,
  requestImageLines,
  substitutionNotices,
  tokenSourceLabel
} from "../../../shared/request-document-model.js";
import {
  breakdownFromPerMessage,
  formatTokensEstimate,
  formatTokensGraded,
  formatTokensScaled,
  resolveTokenCount,
  totalWithVisualTokens
} from "../../../shared/rail-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { currentCount } from "../context/state.js";
import { InspectChrome } from "./InspectPage.js";
import { useInspectKeys } from "./keys.js";
import { RequestDocument, type DocMessage, type DocSection } from "./RequestDocument.js";

/**
 * The next-request viewer (`⌃R` in the TUI): the exact messages the next
 * Continue would send, from the same projection the context meter reads. A
 * count from the model server, when there is one, replaces the estimate.
 */
export function RequestViewer(
  { storyId, payload, onOpenSidebar, onClose }: {
    readonly storyId: string;
    readonly payload: StoryPayload;
    readonly onOpenSidebar: () => void;
    readonly onClose: () => void;
  }
) {
  const { store } = useAppContext();
  const projection = useStore(store, (state) => (state.context.projection?.storyId === storyId ? state.context.projection : null));
  const answer = useStore(store, (state) => currentCount(state.context));
  const [cursor, setCursor] = useState(0);
  const count = answer?.count ?? null;
  const total = projection?.estimate.messages.length ?? 0;
  const selected = Math.max(0, Math.min(Math.max(0, total - 1), cursor));

  useInspectKeys(onClose, (action) => {
    if (action === "up") setCursor(Math.max(0, selected - 1));
    else if (action === "down") setCursor(Math.min(Math.max(0, total - 1), selected + 1));
    else if (action === "top") setCursor(0);
    else if (action === "end") setCursor(Math.max(0, total - 1));
    else return false;
    return true;
  });

  const document = useMemo(() => {
    if (projection === null) return null;
    const { estimate } = projection;
    const resolved = resolveTokenCount(estimate, count);
    const withVisual = totalWithVisualTokens(estimate, resolved, count);
    const breakdown = { ...breakdownFromPerMessage(estimate.plan.entries, resolved.perMessage), visual: estimate.breakdown.visual };
    let imageOrdinal = 0;
    const messages = estimate.messages.map((message, index): DocMessage => {
      const entry = estimate.plan.entries[index]!;
      const images = requestImageLines(entry, estimate, imageOrdinal);
      imageOrdinal = images.ordinal;
      return {
        key: `${index}:${entry.category}:${entry.partId ?? ""}`,
        role: message.role,
        label: `${entry.category} · ${requestEntrySource(entry)}`,
        figure: formatTokensGraded(resolved.perMessage[index]!, resolved.perMessageGrade),
        extra: images.lines,
        content: message.content
      };
    });
    const sections: DocSection[] = [
      { label: "Substitutions", lines: substitutionNotices(estimate) },
      { label: "Activations", lines: activationNotices(estimate) }
    ].filter((section) => section.lines.length > 0);
    const boundary = estimate.plan.requiresEcho
      ? "boundary echo"
      : estimate.messages.at(-1)?.role === "assistant" ? "assistant prefill" : "new passage";
    const parts = [
      `voice ${formatTokensGraded(breakdown.voice, resolved.perMessageGrade)}`,
      `facts ${formatTokensGraded(breakdown.facts, resolved.perMessageGrade)}`,
      `note ${formatTokensGraded(breakdown.note, resolved.perMessageGrade)}`,
      `story ${formatTokensGraded(breakdown.recent, resolved.perMessageGrade)}`,
      `summaries ${formatTokensGraded(breakdown.summary, resolved.perMessageGrade)}`,
      ...(breakdown.visual > 0 ? [`images ${formatTokensEstimate(breakdown.visual)}`] : [])
    ];
    return {
      messages,
      sections,
      tokens: formatTokensGraded(withVisual.total, withVisual.totalGrade),
      route: `operation ${projection.operation} · model ${projection.model} · context window ${projection.contextWindow === null ? "unknown" : formatTokensScaled(projection.contextWindow)} · ${tokenSourceLabel(withVisual.totalGrade)} · ${boundary}`,
      breakdown: parts.join(" · ")
    };
  }, [projection, count]);

  return (
    <InspectChrome
      storyTitle={payload.title}
      title="Next request"
      detail={document === null ? "" : `${document.messages.length} messages · ${document.tokens}`}
      onOpenSidebar={onOpenSidebar}
      onClose={onClose}
    >
      {document === null
        ? <p className="story-empty">Reading the settings…</p>
        : (
          <>
            <p className="request-route">{document.route}</p>
            <p className="request-route">{document.breakdown}</p>
            <RequestDocument
              label="Next request messages"
              sections={document.sections}
              messages={document.messages}
              selected={selected}
              onSelect={setCursor}
              empty="No prompt messages."
            />
          </>
        )}
    </InspectChrome>
  );
}
