import type { StreamReasoning, StreamView } from "./state.js";

const TRIM_CHARACTER = /^\s$/u;
const LEGACY_TRIM_SCAN_LIMIT = 8_192;

export interface StreamTrimBounds {
  start: number;
  end: number;
}

export function emptyStreamText(): Pick<StreamView, "text" | "trimStart" | "trimEnd"> {
  return { text: "", trimStart: 0, trimEnd: 0 };
}

/** Whether the live stream is the one generation currently landing in this
 *  exact part — shared by row-layout.ts and reasoning-model.ts so neither
 *  has to import the other for it. */
export function streamForPart(stream: StreamView | null, partId: string): StreamView | null {
  return stream?.targetId === partId ? stream : null;
}

/** The three shapes a stream can commit as: a fresh sibling take, an append
 * to the settled leaf, or a splice into an existing node's settled text. */
export type StreamMode = "take" | "append" | "rewrite";

export function streamMode(stream: StreamView): StreamMode {
  return stream.rewrite !== undefined ? "rewrite" : stream.append ? "append" : "take";
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

export function emptyStreamReasoning(): StreamReasoning {
  return { text: "", trimStart: 0, trimEnd: 0, tokenCount: 0 };
}

/** Same incremental trim-bound tracking as `appendStreamText`, on
 *  `stream.reasoning` rather than `stream.text` — see that function's own
 *  comment. Creates `stream.reasoning` on first use. `tokenCount` is set
 *  unconditionally, even when `delta` is empty, so a provider-reported
 *  count can update without requiring accompanying text. */
export function appendStreamReasoning(
  stream: StreamView,
  delta: string,
  tokenCount: number
): void {
  const reasoning = stream.reasoning ??= emptyStreamReasoning();
  reasoning.tokenCount = tokenCount;
  if (delta.length === 0) return;
  const current = streamReasoningTrimBounds(stream);
  const oldLength = reasoning.text.length;
  const appended = trimBounds(delta);
  reasoning.text += delta;
  if (appended.end > appended.start) {
    reasoning.trimStart = current.end > current.start
      ? current.start
      : oldLength + appended.start;
    reasoning.trimEnd = oldLength + appended.end;
  } else {
    reasoning.trimStart = current.start;
    reasoning.trimEnd = current.end;
  }
}

export function streamHasSubstantiveReasoning(stream: StreamView): boolean {
  if (stream.reasoning === undefined) return false;
  const bounds = streamReasoningTrimBounds(stream);
  return bounds.end > bounds.start;
}

export function streamReasoningTrimmedText(stream: StreamView): string {
  if (stream.reasoning === undefined) return "";
  const bounds = streamReasoningTrimBounds(stream);
  return stream.reasoning.text.slice(bounds.start, bounds.end);
}

function streamReasoningTrimBounds(stream: StreamView): StreamTrimBounds {
  const reasoning = stream.reasoning ?? emptyStreamReasoning();
  if (validBounds(reasoning.trimStart, reasoning.trimEnd, reasoning.text.length)) {
    return { start: reasoning.trimStart!, end: reasoning.trimEnd! };
  }
  if (reasoning.text.length > LEGACY_TRIM_SCAN_LIMIT) {
    throw new Error("Large stream reasoning text is missing incremental trim metadata.");
  }
  return trimBounds(reasoning.text);
}
