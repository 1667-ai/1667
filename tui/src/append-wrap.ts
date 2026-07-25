import {
  createResumableWrap,
  type ResumableWrap,
  type StyleRun,
  type WrapAppendCandidate
} from "./wrap.js";

const PREFIX_VALIDATION_CHUNK = 8_192;

export interface AppendWrapPlan<Style> {
  text: string;
  runs: readonly StyleRun<Style>[];
  width: number;
}

/** Validate an exact append lineage without a synchronous full-prefix scan,
 * then reuse every prior line except the one the suffix can still change. */
export function createAppendPlanWrap<Style>(
  plan: AppendWrapPlan<Style>,
  candidate: WrapAppendCandidate<Style>
): ResumableWrap<Style> {
  type Phase =
    | "text"
    | "candidate-runs"
    | "plan-runs"
    | "compare-runs"
    | "tail-runs"
    | "delegate"
    | "done";
  let phase: Phase = "text";
  let textOffset = 0;
  let candidateRun = 0;
  let planRun = 0;
  let comparedRun = 0;
  let tailRun = 0;
  const candidatePrefixRuns: StyleRun<Style>[] = [];
  const planPrefixRuns: StyleRun<Style>[] = [];
  const tailRuns: StyleRun<Style>[] = [];
  let delegate: ResumableWrap<Style> | null = null;
  let result: ReturnType<ResumableWrap<Style>["result"]> | null = null;

  const useFullWrap = () => {
    delegate = createResumableWrap(plan.text, plan.runs, plan.width);
    phase = "delegate";
  };

  return {
    advance(shouldYield = () => false) {
      let operations = 0;
      const yieldNow = () => ++operations % 64 === 0 && shouldYield();
      while (phase !== "done") {
        if (phase === "text") {
          if (candidate.text.length > plan.text.length) {
            useFullWrap();
            continue;
          }
          while (textOffset < candidate.text.length) {
            const chunkEnd = Math.min(
              candidate.text.length,
              textOffset + PREFIX_VALIDATION_CHUNK
            );
            while (textOffset < chunkEnd) {
              if (candidate.text.charCodeAt(textOffset) !== plan.text.charCodeAt(textOffset)) {
                useFullWrap();
                break;
              }
              textOffset += 1;
            }
            if (phase !== "text") break;
            if (shouldYield()) return false;
          }
          if (phase === "text") phase = "candidate-runs";
          continue;
        }
        if (phase === "candidate-runs") {
          const run = candidate.runs[candidateRun++];
          if (run === undefined) {
            phase = "plan-runs";
            continue;
          }
          const clipped = clippedRun(run, 0, candidate.start);
          if (clipped !== null) candidatePrefixRuns.push(clipped);
          if (yieldNow()) return false;
          continue;
        }
        if (phase === "plan-runs") {
          const run = plan.runs[planRun++];
          if (run === undefined) {
            if (candidatePrefixRuns.length !== planPrefixRuns.length) {
              useFullWrap();
            } else {
              phase = "compare-runs";
            }
            continue;
          }
          const clipped = clippedRun(run, 0, candidate.start);
          if (clipped !== null) planPrefixRuns.push(clipped);
          if (yieldNow()) return false;
          continue;
        }
        if (phase === "compare-runs") {
          const left = candidatePrefixRuns[comparedRun];
          if (left === undefined) {
            phase = "tail-runs";
            continue;
          }
          if (!sameRun(left, planPrefixRuns[comparedRun]!)) {
            useFullWrap();
            continue;
          }
          comparedRun += 1;
          if (yieldNow()) return false;
          continue;
        }
        if (phase === "tail-runs") {
          const source = plan.runs[tailRun++];
          if (source === undefined) {
            const tail = createResumableWrap(
              plan.text.slice(candidate.start),
              tailRuns,
              plan.width
            );
            delegate = prependWrappedPrefix(candidate, tail);
            phase = "delegate";
            continue;
          }
          const clipped = clippedRun(source, candidate.start, plan.text.length);
          if (clipped !== null) tailRuns.push(clipped);
          if (yieldNow()) return false;
          continue;
        }
        if (phase === "delegate") {
          if (!delegate!.advance(shouldYield)) return false;
          result = delegate!.result();
          phase = "done";
        }
      }
      return true;
    },
    result() {
      if (phase !== "done" || result === null) {
        throw new Error("Wrap result requested before completion.");
      }
      return result;
    }
  };
}

function clippedRun<Style>(
  run: StyleRun<Style>,
  start: number,
  end: number
): StyleRun<Style> | null {
  const clippedStart = Math.max(start, run.start);
  const clippedEnd = Math.min(end, run.end);
  return clippedEnd <= clippedStart ? null : {
    start: clippedStart - start,
    end: clippedEnd - start,
    style: run.style
  };
}

function sameRun<Style>(left: StyleRun<Style>, right: StyleRun<Style>): boolean {
  return left.start === right.start
    && left.end === right.end
    && Object.is(left.style, right.style);
}

function prependWrappedPrefix<Style>(
  prefix: WrapAppendCandidate<Style>,
  tail: ResumableWrap<Style>
): ResumableWrap<Style> {
  const lines: ReturnType<ResumableWrap<Style>["result"]> = [];
  let phase: "tail" | "prefix" | "suffix" | "done" = "tail";
  let prefixLine = 0;
  let suffixLine = 0;
  let suffix: ReturnType<ResumableWrap<Style>["result"]> = [];
  return {
    advance(shouldYield = () => false) {
      if (phase === "tail") {
        if (!tail.advance(shouldYield)) return false;
        suffix = tail.result();
        phase = "prefix";
        if (shouldYield()) return false;
      }
      let operations = 0;
      const yieldNow = () => ++operations % 64 === 0 && shouldYield();
      while (phase === "prefix") {
        if (prefixLine >= prefix.lineCount) {
          phase = "suffix";
          continue;
        }
        lines.push(prefix.source[prefixLine++]!);
        if (yieldNow()) return false;
      }
      while (phase === "suffix") {
        const line = suffix[suffixLine++];
        if (line === undefined) {
          phase = "done";
          continue;
        }
        lines.push({
          ...line,
          start: prefix.start + line.start,
          end: prefix.start + line.end
        });
        if (yieldNow()) return false;
      }
      return true;
    },
    result() {
      if (phase !== "done") throw new Error("Wrap result requested before completion.");
      return lines;
    }
  };
}
