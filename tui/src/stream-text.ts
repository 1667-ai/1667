import type { StreamReasoning, StreamView } from "./state.js";
import {
  createTextPresentation,
  drainTextPresentation,
  type TextPresentation
} from "./text-presentation.js";

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
  stream.presentation?.receive(delta);
}

export function streamHasSubstantiveText(stream: StreamView): boolean {
  const bounds = streamTrimBounds(stream);
  return bounds.end > bounds.start;
}

export function streamTrimmedText(stream: StreamView): string {
  const bounds = streamTrimBounds(stream);
  return stream.text.slice(bounds.start, bounds.end);
}

/** Text currently safe for the visible frame. `stream.text` stays the
 * received, authoritative text used by Stop and durable settlement. */
export function streamPresentedText(stream: StreamView): string {
  const presentation = stream.presentation;
  return presentation === undefined || presentation.bypassed
    ? stream.text
    : presentation.presentedText;
}

export function streamPresentedTrimmedText(stream: StreamView): string {
  const bounds = streamPresentedTrimBounds(stream);
  const text = streamPresentedText(stream);
  return text.slice(bounds.start, bounds.end);
}

export function streamPresentedHasSubstantiveText(stream: StreamView): boolean {
  const bounds = streamPresentedTrimBounds(stream);
  return bounds.end > bounds.start;
}

export function streamPresentedTrimBounds(stream: StreamView): StreamTrimBounds {
  const presentation = stream.presentation;
  return presentation === undefined || presentation.bypassed
    ? streamTrimBounds(stream)
    : {
      start: presentation.presentedTrimStart,
      end: presentation.presentedTrimEnd
    };
}

/** Attach one controller to a prose stream. The callback performs its own
 * ownership check because terminal tails can arrive after Stop. */
export function attachStreamPresentation(
  stream: StreamView,
  onPresented: () => void
): TextPresentation {
  return stream.presentation ??= createTextPresentation({ onPresented });
}

export function attachReasoningPresentation(
  stream: StreamView,
  onPresented: () => void
): TextPresentation {
  const reasoning = stream.reasoning ??= emptyStreamReasoning();
  return reasoning.presentation ??= createTextPresentation({ onPresented });
}

export async function settleStreamPresentation(
  stream: StreamView,
  maxWaitMs?: number
): Promise<boolean> {
  const settled = await Promise.all([
    stream.presentation?.settle(maxWaitMs) ?? Promise.resolve(true),
    stream.reasoning?.presentation?.settle(maxWaitMs) ?? Promise.resolve(true)
  ]);
  return settled.every(Boolean);
}

export function disposeStreamPresentation(stream: StreamView): void {
  stream.presentation?.dispose();
  delete stream.presentation;
  if (stream.reasoning !== undefined) {
    stream.reasoning.presentation?.dispose();
    delete stream.reasoning.presentation;
  }
}

export function suspendStreamPresentation(stream: StreamView): void {
  stream.presentation?.suspend();
  stream.reasoning?.presentation?.suspend();
}

export function resumeStreamPresentation(stream: StreamView): void {
  stream.presentation?.resume();
  stream.reasoning?.presentation?.resume();
}

/** Recover a failed stream without retrying a quarantined grapheme forever.
 * If a controller cannot make one bounded step, it enters one-way bypass.
 * The stream's authoritative text then becomes its visible one-frame
 * fallback; this is safer than rendering a partial grapheme or leaving an
 * empty view. */
export function recoverStreamPresentation(stream: StreamView): boolean {
  let progressed = false;
  const prose = stream.presentation;
  if (prose !== undefined) {
    const changed = prose.recover();
    progressed ||= changed;
  }
  const reasoning = stream.reasoning?.presentation;
  if (reasoning !== undefined) {
    const changed = reasoning.recover();
    progressed ||= changed;
  }
  return progressed;
}

/** Finish a visible adoption lifecycle. A normal bounded settle is preferred;
 * a large but safe queue continues in bounded recovery steps. A quarantined
 * oversized cluster enters bypass and falls back to authoritative text. */
export async function drainStreamPresentation(stream: StreamView): Promise<boolean> {
  const settled = await Promise.all([
    stream.presentation === undefined
      ? Promise.resolve(true)
      : drainTextPresentation(stream.presentation),
    stream.reasoning?.presentation === undefined
      ? Promise.resolve(true)
      : drainTextPresentation(stream.reasoning.presentation)
  ]);
  return settled.every(Boolean);
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
  const presentation = reasoning.presentation;
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
  presentation?.receive(delta);
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

export function streamPresentedReasoningText(stream: StreamView): string {
  const presentation = stream.reasoning?.presentation;
  if (presentation === undefined || presentation.bypassed) return streamReasoningTrimmedText(stream);
  return presentation.presentedText.slice(
    presentation.presentedTrimStart,
    presentation.presentedTrimEnd
  );
}

export function streamPresentedHasSubstantiveReasoning(stream: StreamView): boolean {
  const presentation = stream.reasoning?.presentation;
  if (presentation === undefined || presentation.bypassed) return streamHasSubstantiveReasoning(stream);
  return presentation.presentedTrimEnd > presentation.presentedTrimStart;
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
