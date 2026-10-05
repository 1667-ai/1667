import { imageAttachmentLabel, imageMediaTypeLabel } from "./image-attachment.js";
import { formatTokensEstimate } from "./rail-model.js";
import type { NextRequestEstimate } from "./request-projection.js";
import type { TokenCountGrade } from "./tokenize-source.js";

// The words of the next-request document: what the TUI viewer and the web
// page both say about a request. The two only differ in how they draw them.

/** `tokens exact`, `tokens near-exact`, or `tokens estimated` — the route
 *  line's statement of where the header's and the body's numbers came from. */
export function tokenSourceLabel(grade: TokenCountGrade): string {
  return grade === "exact" ? "tokens exact"
    : grade === "near-exact" ? "tokens near-exact"
    : "tokens estimated";
}

export function substitutionNotices(estimate: NextRequestEstimate): string[] {
  return estimate.substitutions.map((substitution) => {
    if (substitution.kind === "legacy-summary") {
      const count = substitution.omittedPartCount;
      return `Summary take ${substitution.summaryId} starts the raw context. ${count} earlier ${count === 1 ? "part is" : "parts are"} omitted.`;
    }
    const count = substitution.replacedPartIds.length;
    const ids = substitution.replacedPartIds.join(", ");
    return `Chapter ${substitution.chapterNumber} uses summary ${substitution.summaryId} (${formatTokensEstimate(substitution.tokens)}) instead of ${count} raw ${count === 1 ? "part" : "parts"}${ids.length === 0 ? "." : `: ${ids}.`}`;
  });
}

export function activationNotices(estimate: NextRequestEstimate): string[] {
  const notices: string[] = [];
  for (const fact of estimate.activation.facts) {
    const trace = estimate.activation.traces.get(fact.id);
    if (trace === undefined || trace.kind === "always") continue;
    const identity = fact.tag?.trim() || fact.text.split("\n", 1)[0]?.trim() || fact.id;
    const gate = trace.gate === null ? "" : ` with ${trace.gate} secondary keys`;
    notices.push(`Fact ${identity} activated by ${trace.kind} key ${trace.key ?? ""}${gate}${trace.round > 0 ? ` in chain round ${trace.round}` : ""}.`);
  }
  if (estimate.activation.unevaluated.length > 0) {
    notices.push(`${estimate.activation.unevaluated.length} Fact regex key checks were not evaluated because the evaluation budget was reached.`);
  }
  return notices;
}

/** `418 KiB`, `2.3 MiB` - the composer's draft-image rows and the request
 *  viewer's image blocks both show a byte length this way. */
export function formatImageBytes(byteLength: number): string {
  const kib = byteLength / 1024;
  if (kib < 1_000) return `${Math.max(1, Math.round(kib))} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

type PlanEntry = NextRequestEstimate["plan"]["entries"][number];

/** What a message is made from: its block kind and part, or its note depth. */
export function requestEntrySource(entry: PlanEntry): string {
  const kind = entry.turn.blocks[0]?.kind ?? "source";
  if (entry.partId !== undefined) return `${kind} ${entry.partId}`;
  const label = kind.replaceAll("-", " ");
  // The placement the request really used, which may be clamped short of the
  // requested depth. No part follows the note when the story has none, and
  // "depth 0" is not a depth the writer can set, so name that placement.
  if (entry.category !== "note") return label;
  return entry.partsAfterNote === 0
    ? `${label} · before the request`
    : `${label} · depth ${entry.partsAfterNote}`;
}

/** One line for each image in a message, in wire order. `ordinal` counts the
 *  images of the messages before it; the result is the new count. */
export function requestImageLines(
  entry: PlanEntry,
  estimate: Pick<NextRequestEstimate, "imageTokens">,
  ordinal: number
): { readonly lines: string[]; readonly ordinal: number } {
  const lines: string[] = [];
  let count = ordinal;
  for (const block of entry.turn.blocks) {
    if (block.kind !== "image") continue;
    count += 1;
    const attachment = block.image;
    const tokens = estimate.imageTokens.get(attachment.objectId);
    lines.push(`[${imageAttachmentLabel(count - 1)} · ${imageMediaTypeLabel(attachment.mediaType)}`
      + ` · ${attachment.width}×${attachment.height} · ${formatImageBytes(attachment.byteLength)}`
      + (tokens !== undefined && tokens > 0 ? ` · ${formatTokensEstimate(tokens)} tokens` : "")
      + "]");
  }
  return { lines, ordinal: count };
}
