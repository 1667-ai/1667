/** Split complete SSE events off the front of a stream buffer, returning their data payloads and the unconsumed remainder. */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  let match: RegExpMatchArray | null;
  while ((match = rest.match(/\r?\n\r?\n/)) !== null && match.index !== undefined) {
    const rawEvent = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length > 0) events.push(data);
  }
  return { events, rest };
}
