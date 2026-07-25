import type { StreamView } from "./state.js";

const TRIM_CHARACTER = /^\s$/u;
const LEGACY_TRIM_SCAN_LIMIT = 8_192;

export interface StreamTrimBounds {
  start: number;
  end: number;
}

export function emptyStreamText(): Pick<StreamView, "text" | "trimStart" | "trimEnd"> {
  return { text: "", trimStart: 0, trimEnd: 0 };
}

/** Provider deltas are bounded by the worker protocol. Track trim boundaries
 * from the new bytes only so every later render can read them in O(1). */
export function appendStreamText(stream: StreamView, delta: string): void {
  if (delta.length === 0) return;
  const current = streamTrimBounds(stream);
  const oldLength = stream.text.length;
  const appended = trimBounds(delta);
  stream.text += delta;
  if (appended.end > appended.start) {
    stream.trimStart = current.end > current.start
      ? current.start
      : oldLength + appended.start;
    stream.trimEnd = oldLength + appended.end;
  } else {
    stream.trimStart = current.start;
    stream.trimEnd = current.end;
  }
}

export function streamHasSubstantiveText(stream: StreamView): boolean {
  const bounds = streamTrimBounds(stream);
  return bounds.end > bounds.start;
}

export function streamTrimmedText(stream: StreamView): string {
  const bounds = streamTrimBounds(stream);
  return stream.text.slice(bounds.start, bounds.end);
}

export function streamTrimBounds(stream: StreamView): StreamTrimBounds {
  if (validBounds(stream.trimStart, stream.trimEnd, stream.text.length)) {
    return { start: stream.trimStart!, end: stream.trimEnd! };
  }
  if (stream.text.length > LEGACY_TRIM_SCAN_LIMIT) {
    throw new Error("Large stream text is missing incremental trim metadata.");
  }
  return trimBounds(stream.text);
}

function trimBounds(text: string): StreamTrimBounds {
  let first = -1;
  let last = 0;
  let offset = 0;
  for (const character of text) {
    const end = offset + character.length;
    if (!TRIM_CHARACTER.test(character)) {
      if (first < 0) first = offset;
      last = end;
    }
    offset = end;
  }
  return first < 0 ? { start: 0, end: 0 } : { start: first, end: last };
}

function validBounds(
  start: number | undefined,
  end: number | undefined,
  length: number
): boolean {
  return Number.isInteger(start)
    && Number.isInteger(end)
    && start! >= 0
    && end! >= start!
    && end! <= length;
}
