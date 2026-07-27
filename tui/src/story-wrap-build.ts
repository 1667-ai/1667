import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { createAppendPlanWrap } from "./append-wrap.js";
import { projectedAppendText } from "./stream-projection.js";
import { storyProseMeasure } from "./screens/story.js";
import {
  storyPartWrapPlan,
  type StoryPartWrapInput,
  type StoryPartWrapPlan
} from "./screens/story/row-layout.js";
import type { StoryFrameLayout } from "./story-frame-layout.js";
import type { StoryScreenState, StreamView } from "./state.js";
import {
  streamHasSubstantiveText,
  streamTrimmedText
} from "./stream-text.js";
import {
  createResumableWrap,
  type ProseStyle,
  type ResumableWrap,
  type WrapCache
} from "./wrap.js";

export type WrapBuildState = "ready" | "building";

export interface WrapBuildClock {
  now(): number;
  yield(callback: () => void): void;
}

const SYSTEM_CLOCK: WrapBuildClock = {
  now: () => performance.now(),
  yield: (callback) => setTimeout(callback, 0)
};

export interface StoryWrapBuildStats {
  slices: number;
  completed: number;
  replaced: number;
  maxSliceMs: number;
  sliceSamplesMs: readonly number[];
}

export interface StoryWrapBuild {
  ensure(state: StoryScreenState, layout: StoryFrameLayout): WrapBuildState;
  dispose(): void;
  stats(): StoryWrapBuildStats;
}

export interface StoryWrapBuildOptions {
  sliceMs?: number;
  clock?: WrapBuildClock;
  onReady: () => void;
  onError?: (error: unknown) => void;
}

/** The live stream plus the change-detection snapshot taken at capture time.
 * Plans always read the live view — a slice that runs after more deltas
 * landed wraps the fresher text under an equally fresh identity proof — while
 * the snapshot lets ensure() notice growth and replace the job. */
interface StreamCapture {
  live: StreamView;
  textLength: number;
  trimStart: number | undefined;
  trimEnd: number | undefined;
}

interface PlanInput {
  payload: StoryPayload;
  stream: StreamCapture | null;
  measure: number;
}

interface BuildInput extends PlanInput {
  cacheEpoch: number;
}

interface Job {
  input: BuildInput;
  plans: Iterator<StoryPartWrapPlan>;
  plan: StoryPartWrapPlan | null;
  task: ResumableWrap<ProseStyle> | null;
}

interface ReadyInput {
  input: BuildInput;
  cacheRevision: number;
}

const MAX_SLICE_SAMPLES = 2_048;

/** Prewarm exact prose wraps in bounded main-thread slices. The final frame
 * remains wholly synchronous and can only read complete cache entries. */
export function createStoryWrapBuild(
  cache: WrapCache<ProseStyle>,
  options: StoryWrapBuildOptions
): StoryWrapBuild {
  const {
    sliceMs = 6,
    clock = SYSTEM_CLOCK,
    onReady,
    onError = () => undefined
  } = options;
  let active: Job | null = null;
  let readyInput: ReadyInput | null = null;
  let failedInput: BuildInput | null = null;
  let disposed = false;
  let slices = 0;
  let completed = 0;
  let replaced = 0;
  let maxSliceMs = 0;
  let sliceSampleCursor = 0;
  const sliceSamplesMs: number[] = [];

  const recordSlice = (startedAt: number) => {
    const duration = Math.max(0, clock.now() - startedAt);
    slices += 1;
    maxSliceMs = Math.max(maxSliceMs, duration);
    if (sliceSamplesMs.length < MAX_SLICE_SAMPLES) sliceSamplesMs.push(duration);
    else sliceSamplesMs[sliceSampleCursor % MAX_SLICE_SAMPLES] = duration;
    sliceSampleCursor += 1;
  };
  const advance = (job: Job): boolean => {
    const startedAt = clock.now();
    const shouldYield = () => clock.now() - startedAt >= sliceMs;
    while (true) {
      if (active !== job || disposed) return false;
      if (job.plan === null) {
        const next = job.plans.next();
        if (next.done) {
          recordSlice(startedAt);
          return true;
        }
        job.plan = next.value;
        if (shouldYield()) {
          recordSlice(startedAt);
          return false;
        }
      }
      const plan = job.plan;
      if (job.task === null) {
        if (cache.isWarm(plan.partId, plan.width, plan.text, plan.runs, plan.identity)) {
          job.plan = null;
          if (shouldYield()) {
            recordSlice(startedAt);
            return false;
          }
          continue;
        }
        job.task = createPlanWrap(cache, plan);
      }
      if (!job.task.advance(shouldYield)) {
        recordSlice(startedAt);
        return false;
      }
      cache.prime(
        plan.partId,
        plan.width,
        plan.text,
        plan.runs,
        job.task.result(),
        plan.identity
      );
      job.task = null;
      job.plan = null;
      if (shouldYield()) {
        recordSlice(startedAt);
        return false;
      }
    }
  };
  const continueJob = (job: Job) => {
    if (active !== job || disposed) return;
    try {
      if (!advance(job)) return void clock.yield(() => continueJob(job));
      active = null;
      readyInput = { input: job.input, cacheRevision: cache.revision };
      failedInput = null;
      completed += 1;
      onReady();
    } catch (error) {
      active = null;
      failedInput = job.input;
      try { onError(error); } catch { /* reporting cannot restart failed work */ }
      onReady();
    }
  };

  return {
    ensure(state, layout) {
      const input = captureBuildInput(state, layout, cache.epoch);
      const proseVisible = storyFrameShowsProse(state);
      if (active !== null && sameBuildInput(active.input, input)) {
        return proseVisible ? "building" : "ready";
      }
      const replacedActive = active !== null;
      if (replacedActive) {
        replaced += 1;
        active = null;
      }
      if (!replacedActive && readyInput !== null
        && readyInput.cacheRevision === cache.revision
        && sameBuildInput(readyInput.input, input)) {
        failedInput = null;
        return "ready";
      }
      if (failedInput !== null && sameBuildInput(failedInput, input)) {
        return "ready";
      }
      const job: Job = {
        input,
        plans: storyWrapPlans(input),
        plan: null,
        task: null
      };
      active = job;
      if (!proseVisible) {
        clock.yield(() => continueJob(job));
        return "ready";
      }
      try {
        if (advance(job)) {
          active = null;
          readyInput = { input, cacheRevision: cache.revision };
          failedInput = null;
          completed += 1;
          return "ready";
        }
      } catch (error) {
        active = null;
        failedInput = input;
        try { onError(error); } catch { /* reporting cannot restart failed work */ }
        return "ready";
      }
      clock.yield(() => continueJob(job));
      return "building";
    },
    dispose() {
      disposed = true;
      active = null;
    },
    stats: () => ({
      slices,
      completed,
      replaced,
      maxSliceMs,
      sliceSamplesMs: [...sliceSamplesMs]
    })
  };
}

function createPlanWrap(
  cache: WrapCache<ProseStyle>,
  plan: StoryPartWrapPlan
): ResumableWrap<ProseStyle> {
  const candidate = plan.appendStart === null
    ? null
    : cache.appendCandidate(
      plan.partId,
      plan.width,
      plan.appendStart
  );
  return candidate === null
    ? createResumableWrap(plan.text, plan.runs, plan.width)
    : createAppendPlanWrap(plan, candidate);
}

export function storyFrameWrapPlans(
  state: StoryScreenState,
  layout: StoryFrameLayout
): StoryPartWrapPlan[] {
  return [...storyWrapPlans(capturePlanInput(state, layout))];
}

function storyFrameShowsProse(state: StoryScreenState): boolean {
  const mapVisible = state.map !== null && (state.mode === "MAP"
    || state.mode === "TAG" && state.tag?.returnMode === "MAP");
  return !(mapVisible
    || state.mode === "EDITOR" && state.editor !== null
    || state.mode === "COMPOSE" && state.composer.fullscreen);
}

function captureBuildInput(
  state: StoryScreenState,
  layout: StoryFrameLayout,
  cacheEpoch: number
): BuildInput {
  return { ...capturePlanInput(state, layout), cacheEpoch };
}

function capturePlanInput(state: StoryScreenState, layout: StoryFrameLayout): PlanInput {
  return {
    payload: state.payload,
    stream: state.stream === null ? null : {
      live: state.stream,
      textLength: state.stream.text.length,
      trimStart: state.stream.trimStart,
      trimEnd: state.stream.trimEnd
    },
    measure: storyProseMeasure(layout.pageWidth)
  };
}

function sameBuildInput(left: BuildInput, right: BuildInput): boolean {
  return left.payload === right.payload
    && left.measure === right.measure
    && left.cacheEpoch === right.cacheEpoch
    && sameStreamCapture(left.stream, right.stream);
}

// A StreamView is replaced, never rewritten, so identity plus the captured
// text extent is the complete change signal.
function sameStreamCapture(left: StreamCapture | null, right: StreamCapture | null): boolean {
  return left === right || (left !== null && right !== null
    && left.live === right.live
    && left.textLength === right.textLength
    && left.trimStart === right.trimStart
    && left.trimEnd === right.trimEnd);
}

/** Yield one canonical wrap plan at a time. No payload-wide projection or
 * cache scan happens before the build clock starts. */
function* storyWrapPlans(input: PlanInput): Generator<StoryPartWrapPlan> {
  const { payload, measure } = input;
  const stream = input.stream?.live ?? null;
  const substantive = stream !== null && streamHasSubstantiveText(stream);
  if (stream !== null && substantive && !stream.append && stream.parentId === null) {
    yield streamTakePlan(payload, stream, measure);
    return;
  }

  for (const node of payload.path) {
    const partStream = stream?.targetId === node.id ? stream : null;
    // The projection already materialized this exact settled+streamed string;
    // consume it instead of concatenating a second copy per delta batch.
    const projected = partStream?.append === true && substantive
      ? { ...node, text: projectedAppendText(payload, partStream, node) }
      : node;
    yield storyPartWrapPlan(
      wrapInput(projected),
      partStream,
      measure,
      node.text.length,
      node
    );
    if (stream !== null && substantive && !stream.append && node.id === stream.parentId) {
      yield streamTakePlan(payload, stream, measure);
      return;
    }
  }
}

function streamTakePlan(
  payload: StoryPayload,
  stream: StreamView,
  measure: number
): StoryPartWrapPlan {
  const node: StoryNode = {
    id: stream.targetId,
    parentId: stream.parentId,
    instruction: stream.instruction,
    text: streamTrimmedText(stream),
    model: "writing",
    createdAt: stream.startedAt,
    activeChildId: null
  };
  return storyPartWrapPlan(
    wrapInput(node),
    stream,
    measure,
    node.text.length,
    payload
  );
}

function wrapInput(node: StoryNode): StoryPartWrapInput {
  return {
    id: node.id,
    node,
    isSummary: node.role === "summary",
    humanSpans: node.attribution?.source === "human" ? node.attribution.ranges : []
  };
}
