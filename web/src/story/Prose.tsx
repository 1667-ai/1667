import { Fragment } from "react";
import type { HumanEditAttribution, TextRange } from "../../../shared/types.js";

/**
 * Paragraphs on `\n{2,}`, each carrying its own text offset so a human-edit
 * span (UTF-16 offsets into the whole take) can be sliced back out per
 * paragraph. Ported from `~/source/storytavern/web/src/PartCard.tsx`'s
 * `Prose`/`AttributedText`/`paragraphsWithOffsets` (read-only here — no
 * `onMouseUp` selection wiring, no rewrite caret).
 *
 * `caret` (#409 step 5) appends the blinking `.caret` span right after the
 * text, inline in the last paragraph — the one place a streaming take's
 * cursor belongs, whether that paragraph is empty (a fresh part or new
 * paragraph about to start) or mid-sentence.
 */
export function Prose({
  text,
  humanEdit = null,
  caret = false
}: {
  text: string;
  humanEdit?: HumanEditAttribution | null;
  caret?: boolean;
}) {
  const paragraphs = paragraphsWithOffsets(text);
  return (
    <div className="prose">
      {paragraphs.map((paragraph, index) => (
        <p key={paragraph.start}>
          <AttributedText text={paragraph.text} offset={paragraph.start} ranges={humanEdit?.ranges ?? []} />
          {caret && index === paragraphs.length - 1 && <span className="caret" aria-hidden="true" />}
        </p>
      ))}
    </div>
  );
}

function AttributedText({ text, offset, ranges }: { text: string; offset: number; ranges: readonly TextRange[] }) {
  const paragraphEnd = offset + text.length;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(offset, range.start);
    const end = Math.min(paragraphEnd, range.end);
    if (start >= end) continue;
    const localStart = start - offset;
    const localEnd = end - offset;
    if (cursor < localStart) pieces.push(text.slice(cursor, localStart));
    pieces.push(
      <mark className="human-edit-mark" title="Edited by you" key={`${localStart}:${localEnd}`}>
        {text.slice(localStart, localEnd)}
      </mark>
    );
    cursor = localEnd;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <Fragment>{pieces}</Fragment>;
}

function paragraphsWithOffsets(text: string): { text: string; start: number }[] {
  const result: { text: string; start: number }[] = [];
  const separator = /\n{2,}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    result.push({ text: text.slice(last, match.index), start: last });
    last = match.index + match[0].length;
  }
  result.push({ text: text.slice(last), start: last });
  return result;
}
