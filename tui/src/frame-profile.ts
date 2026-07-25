import type { CliRendererStats } from "@opentui/core";
import type { FrameSchedulerStats } from "./frame-scheduler.js";
import type { StoryWrapBuildStats } from "./story-wrap-build.js";

export type FrameProfilePhase = "prepare" | "render" | "surface" | "total" | "presentation";

export interface SampleDistribution {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TuiFrameProfileReport {
  schemaVersion: 1;
  scheduler: Omit<FrameSchedulerStats, "buildSamplesMs"> & { build: SampleDistribution };
  application: {
    committedFrames: number;
    loadingFrames: number;
    prepare: SampleDistribution;
    render: SampleDistribution;
    surface: SampleDistribution;
    total: SampleDistribution;
    presentation: SampleDistribution;
  };
  wrap: {
    cacheHits: number;
    cacheMisses: number;
    coldBuildsCompleted: number;
    coldBuildsReplaced: number;
    coldSlices: SampleDistribution;
  };
  native: {
    frameCount: number;
    averageFrameTimeMs: number;
    maxFrameTimeMs: number;
    frameCallbackTimeMs: number;
    nativeFrameCount: number;
    nativeAverageFrameTimeMs: number;
    nativeRenderTimeMs: number | null;
    nativeStdoutWriteTimeMs: number | null;
  } | null;
}

export interface FrameProfile {
  record(phase: FrameProfilePhase, durationMs: number): void;
  committed(loading?: boolean): void;
  report(
    scheduler: FrameSchedulerStats,
    cold: StoryWrapBuildStats,
    cache: { readonly hits: number; readonly misses: number },
    native: CliRendererStats | null
  ): TuiFrameProfileReport;
}

const MAX_SAMPLES = 2_048;

export function createFrameProfile(): FrameProfile {
  const samples = new Map<FrameProfilePhase, number[]>();
  const cursors = new Map<FrameProfilePhase, number>();
  let committedFrames = 0;
  let loadingFrames = 0;
  return {
    record(phase, durationMs) {
      const values = samples.get(phase) ?? [];
      const cursor = cursors.get(phase) ?? 0;
      if (values.length < MAX_SAMPLES) values.push(durationMs);
      else values[cursor % MAX_SAMPLES] = durationMs;
      samples.set(phase, values);
      cursors.set(phase, cursor + 1);
    },
    committed(loading = false) {
      committedFrames += 1;
      if (loading) loadingFrames += 1;
    },
    report(scheduler, cold, cache, native) {
      const { buildSamplesMs, ...schedulerCounts } = scheduler;
      return {
        schemaVersion: 1,
        scheduler: { ...schedulerCounts, build: distribution(buildSamplesMs) },
        application: {
          committedFrames,
          loadingFrames,
          prepare: distribution(samples.get("prepare") ?? []),
          render: distribution(samples.get("render") ?? []),
          surface: distribution(samples.get("surface") ?? []),
          total: distribution(samples.get("total") ?? []),
          presentation: distribution(samples.get("presentation") ?? [])
        },
        wrap: {
          cacheHits: cache.hits,
          cacheMisses: cache.misses,
          coldBuildsCompleted: cold.completed,
          coldBuildsReplaced: cold.replaced,
          coldSlices: distribution(cold.sliceSamplesMs)
        },
        native: native === null ? null : {
          frameCount: native.frameCount,
          averageFrameTimeMs: native.averageFrameTime,
          maxFrameTimeMs: native.maxFrameTime,
          frameCallbackTimeMs: native.frameCallbackTime,
          nativeFrameCount: native.nativeFrameCount,
          nativeAverageFrameTimeMs: native.nativeAverageFrameTime,
          nativeRenderTimeMs: native.nativeRenderTime ?? null,
          nativeStdoutWriteTimeMs: native.nativeStdoutWriteTime ?? null
        }
      };
    }
  };
}

export function distribution(values: readonly number[]): SampleDistribution {
  if (values.length === 0) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1)!
  };
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
}
