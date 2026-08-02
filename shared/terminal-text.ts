/** The glyph that shows where a control character was.
 *
 * One mark per character, never per run. The projection below preserves length
 * and cell width, and collapsing a run would move every column to its right —
 * breaking wrapping, truncation, the wrap cache, caret placement, and the
 * selection map. */
export const CONTROL_MARK = "▪";

// The strict regime marks LF and the bidi controls. The prose regime keeps
// them, because a wrapper owns the line breaks and right-to-left writing needs
// the overrides. Both keep TAB, and both read a lone CR as a space.
const LINE_CLASS = "\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069";
const PROSE_CLASS = "\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029";

// A matcher and a replacer per regime. The matcher carries no `g`, so it holds
// no `lastIndex` between calls. This runs on every segment of every frame, and
// a stale index would let an escape sequence reach the terminal.
const LINE_MATCH = new RegExp(`[${LINE_CLASS}]`);
const LINE_REPLACE = new RegExp(`[${LINE_CLASS}]`, "g");
const PROSE_MATCH = new RegExp(`[${PROSE_CLASS}]`);
const PROSE_REPLACE = new RegExp(`[${PROSE_CLASS}]`, "g");

const replacer = (character: string): string =>
  character === "\r" ? " " : CONTROL_MARK;

/** Strict: a single-row field, a file name, a tag, or any chrome. */
export function terminalLineText(value: string): string {
  return LINE_MATCH.test(value) ? value.replace(LINE_REPLACE, replacer) : value;
}

/** Lenient: prose a wrapper laid out. Keeps LF and the bidi controls. */
export function terminalProseText(value: string): string {
  return PROSE_MATCH.test(value) ? value.replace(PROSE_REPLACE, replacer) : value;
}
