/**
 * Splits a raw completion stream into prose and reasoning around paired
 * `<think>` tags.
 *
 * A chat route hands reasoning over as its own field (`reasoning_content`),
 * so `server/providers.ts` never has to look at the prose for it. A text
 * completion route has one undifferentiated token stream, so a thinking
 * model's `<think>...</think>` arrives inline. This is the only place that
 * knows the tag shape; everything downstream of it (the reasoning relay, the
 * capture, the stored record, the gutter) is already protocol-neutral.
 *
 * Deltas arrive at whatever boundary the provider chose, so a tag can be
 * divided across any number of them. `push` therefore holds back the longest
 * suffix of its buffer that could still grow into the tag it is watching for,
 * and releases it as ordinary text once a later delta proves it is not one.
 * `finish` flushes whatever is still held: at the end of a stream, a partial
 * tag was never a tag.
 */

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** One push's worth of split output. Either side can be empty: a delta fully
 *  inside a thought contributes no prose, and a delta held back entirely for
 *  a possible tag contributes neither. */
export interface ThinkTagSplitDelta {
  readonly prose: string;
  readonly reasoning: string;
}

export interface ThinkTagSplitter {
  push(delta: string): ThinkTagSplitDelta;
  /** Releases the held-back tail to whichever side owns it. An unclosed
   *  `<think>` keeps its text as reasoning, which is what a generation that
   *  stopped mid-thought actually produced. */
  finish(): ThinkTagSplitDelta;
  /** True while the stream sits between an open tag and its close. */
  readonly inThought: boolean;
}

/** The longest suffix of `text` that is also a proper prefix of `marker`,
 *  which is exactly how much has to be held back to recognise a marker that
 *  the next delta completes. Zero when no suffix can grow into one. */
function heldPrefixLength(text: string, marker: string): number {
  const most = Math.min(text.length, marker.length - 1);
  for (let length = most; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

export function createThinkTagSplitter(): ThinkTagSplitter {
  let buffer = "";
  let inside = false;
  return {
    get inThought() {
      return inside;
    },
    push(delta: string): ThinkTagSplitDelta {
      if (delta.length === 0) return { prose: "", reasoning: "" };
      buffer += delta;
      let prose = "";
      let reasoning = "";
      for (;;) {
        const marker = inside ? CLOSE_TAG : OPEN_TAG;
        const at = buffer.indexOf(marker);
        if (at >= 0) {
          const before = buffer.slice(0, at);
          if (inside) reasoning += before;
          else prose += before;
          buffer = buffer.slice(at + marker.length);
          inside = !inside;
          continue;
        }
        const held = heldPrefixLength(buffer, marker);
        const release = buffer.slice(0, buffer.length - held);
        if (inside) reasoning += release;
        else prose += release;
        buffer = buffer.slice(buffer.length - held);
        return { prose, reasoning };
      }
    },
    finish(): ThinkTagSplitDelta {
      const tail = buffer;
      buffer = "";
      if (tail.length === 0) return { prose: "", reasoning: "" };
      return inside ? { prose: "", reasoning: tail } : { prose: tail, reasoning: "" };
    }
  };
}
