import { wrapText } from "../wrap.js";
import { truncate, visibleWidth } from "./story/frame.js";

/** Decision 24 · the wrapping law for the whole 04 feedback family.
 *
 *  Feedback wraps on word boundaries into a 2-col hanging indent under the
 *  message's first character; the `▲`/`▸` glyph never repeats, so the block
 *  still reads as one event. Past the cap the **body** truncates with `…`.
 *
 *  The binding rule: **the last line always carries the recovery keys.** A
 *  one-line clip loses exactly the part that says what to do, which is why
 *  the final wrapped row survives truncation while the middle of the message
 *  is what goes. */
export interface WrappedFeedback {
  readonly rows: readonly string[];
  /** True when the body was cut and the message is only complete in the log. */
  readonly truncated: boolean;
}

export function wrapFeedback(
  text: string,
  measure: number,
  cap: number,
  /** How to reach the whole message — `! full`, or null where `!` is not
   *  live. Rides the last row, ahead of the recovery keys it already holds. */
  overflow: string | null = null
): WrappedFeedback {
  const room = Math.max(1, measure);
  const clean = text.replace(/\s+/gu, " ").trim();
  const rows = wrapRows(clean, room);
  if (rows.length === 0) return { rows: [], truncated: false };
  if (rows.length <= cap) return { rows, truncated: false };
  // Feedback names its recovery keys in the trailing `·` clauses. Keeping the
  // whole run of them is the point of the law: taking only the last would drop
  // `R retries` from `R retries · , opens settings`, and wrapping alone would
  // let the cap fall in the middle of it.
  const split = recoveryStart(clean, room);
  const tail = split === -1 ? "" : clean.slice(split + SEPARATOR.length);
  const body = split === -1 ? clean : clean.slice(0, split);
  const last = lastRow(tail, overflow, room);
  const kept = wrapRows(last === null ? clean : body, room)
    .slice(0, Math.max(1, cap - 1));
  // A message that is nothing but its recovery run leaves no body to mark.
  if (kept.length === 0) return { rows: [last ?? rows.at(-1)!], truncated: true };
  kept[kept.length - 1] = truncate(`${kept.at(-1)!} …`, room);
  return {
    rows: [...kept, last ?? truncate(rows.at(-1)!, room)],
    truncated: true
  };
}

const SEPARATOR = " · ";

/** Where the trailing run of recovery clauses begins: the earliest `·` split
 *  whose whole tail still fits one row. A clause names a key, so once the run
 *  no longer fits, the clauses nearest the end are the ones that survive. */
function recoveryStart(text: string, room: number): number {
  let split = -1;
  for (let at = text.lastIndexOf(SEPARATOR); at !== -1; at = text.lastIndexOf(SEPARATOR, at - 1)) {
    if (visibleWidth(text.slice(at + SEPARATOR.length)) > room) break;
    split = at;
  }
  return split;
}

function wrapRows(text: string, room: number): string[] {
  return wrapText(text, [], room)
    .map((line) => line.text)
    .filter((line) => line.length > 0);
}

/** The recovery row, with the route to the whole message ahead of it where
 *  both still fit. A tail too wide to stand alone is no better than the last
 *  wrapped line, so the caller falls back to that. */
function lastRow(tail: string, overflow: string | null, room: number): string | null {
  if (tail.length === 0 || visibleWidth(tail) > room) return null;
  if (overflow === null) return tail;
  const combined = `${overflow}${SEPARATOR}${tail}`;
  return visibleWidth(combined) <= room ? combined : tail;
}
