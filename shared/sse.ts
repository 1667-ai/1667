// "\r\n\r\n", the longest form the event separator can take.
const MAX_SEPARATOR_LENGTH = 4;

/** Keep an idle HTTP stream visible through proxies and detectable by clients. */
export const SSE_HEARTBEAT_INTERVAL_MS = 1_000;
/** Four missed loopback heartbeats identify a stream that no longer carries data. */
export const SSE_IDLE_TIMEOUT_MS = SSE_HEARTBEAT_INTERVAL_MS * 4;

/**
 * Split complete SSE events off the front of a stream buffer, returning
 * their data payloads and the unconsumed remainder.
 *
 * `searchFrom` resumes the separator search after the position the previous
 * call already ruled out, instead of rescanning the whole buffer. A caller
 * that keeps appending network chunks to a growing buffer — one SSE line
 * with no separator until its very end, for example a large completion
 * payload — passes back `nextSearchFrom` on the next call so each new chunk
 * costs a scan of itself, not a rescan of everything already ruled out.
 *
 * A separator can straddle two chunks, so `nextSearchFrom` backs up by
 * `MAX_SEPARATOR_LENGTH - 1` characters from the end of the unconsumed
 * remainder rather than resuming exactly where the search stopped — the
 * only region a newly arriving chunk could complete a separator over.
 *
 * Caller obligation: pass back this call's `rest` as the next call's
 * `buffer`, and this call's `nextSearchFrom` as the next call's
 * `searchFrom`. Skip this, and events go silently missing.
 */
export function splitSseEvents(
  buffer: string,
  searchFrom = 0
): { events: string[]; rest: string; nextSearchFrom: number } {
  const separator = /\r?\n\r?\n/g;
  separator.lastIndex = searchFrom;
  const events: string[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(buffer)) !== null) {
    const rawEvent = buffer.slice(consumed, match.index);
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length > 0) events.push(data);
    consumed = match.index + match[0].length;
    separator.lastIndex = consumed;
  }
  const rest = buffer.slice(consumed);
  const nextSearchFrom = Math.max(0, rest.length - (MAX_SEPARATOR_LENGTH - 1));
  return { events, rest, nextSearchFrom };
}
