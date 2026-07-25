// "Copy the boundary, then output the marker" legitimately reads as "marker on
// its own line" — allow a short whitespace bridge, never other characters.
const CONTRACT_WHITESPACE_BRIDGE = 24;
export const REWRITE_ECHO_CONTEXT_CHARACTERS = 600;

/**
 * Bare-mode replies occasionally open or close with a run of the text adjacent
 * to the mark (live-tested small-model habit). Those characters already exist
 * in the story on both sides of the splice, so drop any exact overlap at either
 * end. Short overlaps are more likely replacement prose than echo — keep them.
 */
export function stripEchoedContext(replacement: string, before: string, after: string): string {
  const MIN_ECHO_CHARACTERS = 8;
  const beforeTail = before.slice(-REWRITE_ECHO_CONTEXT_CHARACTERS).trimEnd();
  const afterHead = after.slice(0, REWRITE_ECHO_CONTEXT_CHARACTERS).trimStart();
  let text = replacement;
  const head = longestBoundaryOverlap(beforeTail, text);
  if (head >= MIN_ECHO_CHARACTERS) text = text.slice(head).trimStart();
  const tail = longestBoundaryOverlap(reverse(afterHead), reverse(text));
  if (tail >= MIN_ECHO_CHARACTERS) text = text.slice(0, text.length - tail).trimEnd();
  return text;
}

/** Longest k where the end of `beforeText` equals the start of `candidate` —
 *  i.e. the candidate opens by re-copying text that ends at the boundary. */
export function longestBoundaryOverlap(beforeText: string, candidate: string): number {
  for (let k = Math.min(beforeText.length, candidate.length); k > 0; k--) {
    if (candidate.slice(0, k) === beforeText.slice(beforeText.length - k)) return k;
  }
  return 0;
}

/** Code-unit reversal: only used for symmetric equality checks, and keeping k
 *  in code units lets the caller slice the original string with it directly. */
function reverse(value: string): string {
  return value.split("").reverse().join("");
}

/** Streaming filter: remove a provider-echoed prefill and withhold the exact
 * right-edge contract so only replacement prose reaches the browser. The seams
 * themselves stay byte-exact, but their packaging is forgiven where live testing
 * showed models get it wrong while still proving the seam: an echo of MORE
 * preceding text than the anchor, a right anchor wrapped in the literal prompt
 * tag, and a right anchor whose end marker never arrives. */
export class AnchoredOutputFilter {
  private prefixBuffer = "";
  private prefixDecided: boolean;
  private suffixBuffer = "";
  private stopped = false;
  private readonly beforeTail: string;
  private readonly contract: RegExp | null;
  private readonly trailingAnchor: RegExp | null;
  private readonly maxContractLength: number;
  matchedContract = false;
  matchedPrefix: boolean;

  constructor(
    private readonly echoedPrefix: string,
    rightAnchor: string,
    endMarker: string,
    private readonly requirePrefix = false,
    options: { beforeTail?: string; anchorWrapTag?: string } = {}
  ) {
    // The overlap rule needs text that ends exactly where the anchor ends;
    // anything else would misplace the boundary, so fall back to the anchor.
    this.beforeTail = options.beforeTail !== undefined && options.beforeTail.endsWith(echoedPrefix)
      ? options.beforeTail
      : echoedPrefix;
    this.prefixDecided = echoedPrefix.length === 0;
    this.matchedPrefix = !requirePrefix || echoedPrefix.length === 0;
    const bridge = rightAnchor.length > 0 ? CONTRACT_WHITESPACE_BRIDGE : 0;
    const wrapTag = options.anchorWrapTag !== undefined && rightAnchor.length > 0 ? options.anchorWrapTag : null;
    const anchorPattern = wrapTag === null
      ? escapeRegExp(rightAnchor)
      : `(?:<${escapeRegExp(wrapTag)}>\\s{0,8})?${escapeRegExp(rightAnchor)}(?:\\s{0,8}</${escapeRegExp(wrapTag)}>)?`;
    this.contract = endMarker.length === 0
      ? null
      : new RegExp(`${anchorPattern}\\s{0,${bridge}}${escapeRegExp(endMarker)}`);
    this.trailingAnchor = this.contract === null || rightAnchor.length === 0
      ? null
      : new RegExp(`${anchorPattern}$`);
    this.maxContractLength = rightAnchor.length + bridge + endMarker.length
      + (wrapTag === null ? 0 : 2 * (wrapTag.length + 3) + 16);
  }

  push(delta: string): string {
    if (this.stopped || delta.length === 0) return "";
    let text = delta;
    if (!this.prefixDecided) {
      this.prefixBuffer += text;
      // A model that opens with a stray newline before the echo still counts.
      const candidate = this.prefixBuffer.replace(/^\s+/u, "");
      if (candidate.startsWith(this.echoedPrefix)) {
        this.matchedPrefix = true;
        this.prefixDecided = true;
        this.prefixBuffer = "";
        text = candidate.slice(this.echoedPrefix.length);
      } else if (this.echoedPrefix.startsWith(candidate)) {
        return "";
      } else if (this.requirePrefix && candidate.length < this.beforeTail.length) {
        // The opening diverged from the anchor but may still be a longer echo
        // of the preceding text; hold until there is enough to decide.
        return "";
      } else {
        text = this.decidePrefix(candidate);
      }
    }
    return this.pushSuffix(text);
  }

  finish(): string {
    if (!this.prefixDecided) {
      // A full exact echo would already have been decided by push(); what is
      // left is either a partial echo or a held opening awaiting the overlap
      // decision, and decidePrefix resolves both.
      const pending = this.decidePrefix(this.prefixBuffer.replace(/^\s+/u, ""));
      return this.pushSuffix(pending) + this.flushSuffix();
    }
    return this.flushSuffix();
  }

  /** The buffered opening is not an exact anchor echo. Accept it when it starts
   *  with a longer run of the preceding text ending at the same boundary —
   *  models often copy more context than the anchor they were asked for. */
  private decidePrefix(candidate: string): string {
    const buffered = this.prefixBuffer;
    this.prefixBuffer = "";
    this.prefixDecided = true;
    const overlap = longestBoundaryOverlap(this.beforeTail, candidate);
    if (this.echoedPrefix.length > 0 && overlap >= this.echoedPrefix.length) {
      this.matchedPrefix = true;
      return candidate.slice(overlap);
    }
    return buffered;
  }

  private pushSuffix(text: string): string {
    if (this.stopped || text.length === 0) return "";
    if (this.contract === null) return text;
    this.suffixBuffer += text;
    const boundary = this.contract.exec(this.suffixBuffer);
    if (boundary !== null) {
      const visible = this.suffixBuffer.slice(0, boundary.index);
      this.suffixBuffer = "";
      this.stopped = true;
      this.matchedContract = true;
      return visible;
    }
    // Retain the longest possible partial contract so a match split across
    // stream chunks is never flushed as visible prose.
    const retained = Math.min(Math.max(0, this.maxContractLength - 1), this.suffixBuffer.length);
    const visible = this.suffixBuffer.slice(0, this.suffixBuffer.length - retained);
    this.suffixBuffer = this.suffixBuffer.slice(this.suffixBuffer.length - retained);
    return visible;
  }

  private flushSuffix(): string {
    if (this.stopped) return "";
    const pending = this.suffixBuffer;
    this.suffixBuffer = "";
    // The stream ended on the exact right boundary with no end marker after it.
    // The seam itself is verified — accept the output and cut at the echo.
    if (!this.matchedContract && this.trailingAnchor !== null) {
      const boundary = this.trailingAnchor.exec(pending.replace(/\s+$/u, ""));
      if (boundary !== null) {
        this.matchedContract = true;
        return pending.slice(0, boundary.index);
      }
    }
    return pending;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
