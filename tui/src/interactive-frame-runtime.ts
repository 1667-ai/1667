import {
  CliRenderEvents,
  type CliRenderer,
  type CliRendererFrameEvent,
  type CliRendererStats
} from "@opentui/core";
import {
  createAnimationDeadlineScheduler,
  createFrameDeadlineCollector
} from "./animation-deadline.js";
import { createFrameScheduler } from "./frame-scheduler.js";
import {
  createFrameProfile,
  type TuiFrameProfileReport
} from "./frame-profile.js";
import type { Palette } from "./palette.js";
import { renderStoryScreen, storyProseMeasure } from "./screens/story.js";
import { fitLine, segment, type FrameLine } from "./screens/story/frame.js";
import type { RuntimeState } from "./state.js";
import type { StorySurface } from "./story-surface.js";
import {
  deriveStoryFrameLayout,
  singlePaneStoryFrameLayout
} from "./story-frame-layout.js";
import { createStoryWrapBuild } from "./story-wrap-build.js";
import type { ProseStyle, WrapCache } from "./wrap.js";

export type FrameInvalidationReason = "state" | "resize";

export interface InteractiveFrameRuntime {
  invalidate(reason?: FrameInvalidationReason): void;
  flush(): void;
  /** Claim the one safe repaint recovery without admitting stale input data. */
  requestInputRecovery(): void;
  dispose(): void;
  profile(native: CliRendererStats | null): TuiFrameProfileReport | null;
  readonly version: number;
  readonly frameToken: number;
  readonly failed: boolean;
  readonly inputRecoveryExhausted: boolean;
}

export interface InteractiveFrameRuntimeOptions {
  state: RuntimeState;
  renderer: CliRenderer;
  surface: StorySurface;
  palette(): Palette;
  wrapCache: WrapCache<ProseStyle>;
  onBuilt(version: number, interactive: boolean, frameToken: number): void;
  onPresented?(frameToken: number): void;
  onPresentationFailure?(): void;
  onError(error: unknown): void;
  profile?: boolean;
}

interface PendingPresentation {
  frameToken: number;
  /** A commit made during a native frame requests a guaranteed follow-up. */
  minimumNativeFrameId: number;
  invalidatedAt: number | null;
  attempts: number;
}

type FailureRecoveryState = "unclaimed" | "claimed" | "exhausted";

/** Own frame coalescing, cold prose preparation, visible animation deadlines,
 * and the atomic surface/derived-state commit. */
export function createInteractiveFrameRuntime(
  options: InteractiveFrameRuntimeOptions
): InteractiveFrameRuntime {
  const { state, renderer, surface, wrapCache, onBuilt, onError } = options;
  let version = 0;
  let frameToken = 0;
  let frameFailed = false;
  let failureRecovery: FailureRecoveryState = "unclaimed";
  let retryNeedsApplicationPaint = false;
  let deferredFailureReason: "state" | "resize" | "animation" | "cold-ready" | null = null;
  let resizePending = false;
  let painted = false;
  let paintedStoryId: string | null = null;
  let loadingStoryId: string | null = null;
  let pendingInvalidationAt: number | null = null;
  let pendingPresentation: PendingPresentation | null = null;
  let preparedProseMeasure: number | null = null;
  let disposed = false;
  const profile = options.profile === true ? createFrameProfile() : null;
  const requestFrame = (reason: "state" | "resize" | "animation" | "cold-ready") => {
    if (reason === "resize") resizePending = true;
    if (profile !== null) pendingInvalidationAt ??= performance.now();
    if (frameFailed) {
      deferredFailureReason = reason;
      return;
    }
    scheduler.invalidate(reason);
  };
  const reportFrameFailure = (error: unknown, applicationPaint: boolean) => {
    pendingPresentation = null;
    frameFailed = true;
    if (failureRecovery === "claimed") failureRecovery = "exhausted";
    retryNeedsApplicationPaint = applicationPaint;
    // A setter may have rebound the old native range onto partial pixels.
    // Failed pixels own neither visible selection nor new selection gestures.
    try { renderer.clearSelection(); } catch {
      /* native selection cleanup cannot suppress failure admission */
    }
    try { surface.setPageSelectable(false); } catch {
      /* disabling a broken surface cannot suppress failure admission */
    }
    try { onError(error); } catch {
      /* reporting cannot poison the input escape */
    }
    try { options.onPresentationFailure?.(); } catch {
      /* an escape failure cannot revive an unsafe queued reducer */
    }
  };
  const requestNativePresentation = (pending: PendingPresentation) => {
    try {
      renderer.requestRender();
      void renderer.idle().then(() => {
        if (disposed || pendingPresentation !== pending) return;
        if (pending.attempts >= 2) {
          reportFrameFailure(new Error("native frame presentation failed after retry"), false);
          return;
        }
        pending.attempts += 1;
        pending.minimumNativeFrameId = renderer.frameId + 1;
        requestNativePresentation(pending);
      }, (error) => {
        if (disposed || pendingPresentation !== pending) return;
        reportFrameFailure(error, false);
      });
    } catch (error) {
      if (disposed || pendingPresentation !== pending) return;
      reportFrameFailure(error, false);
    }
  };
  const requestPresentation = (presentedFrameToken: number, loading = false) => {
    const pending = {
      frameToken: presentedFrameToken,
      minimumNativeFrameId: renderer.frameId + 1,
      invalidatedAt: pendingInvalidationAt,
      attempts: 1
    };
    pendingPresentation = pending;
    if (profile !== null) {
      pendingInvalidationAt = null;
      profile.committed(loading);
    }
    // FRAME fires before idle settles on success. Settling without FRAME proves
    // OpenTUI's native failure path completed and is waiting for a new request.
    requestNativePresentation(pending);
  };
  const animations = createAnimationDeadlineScheduler(() => requestFrame("animation"));
  const cold = createStoryWrapBuild(wrapCache, {
    onReady: () => requestFrame("cold-ready"),
    onError
  });
  const scheduler = createFrameScheduler(() => {
    if (frameFailed && failureRecovery !== "claimed") {
      deferredFailureReason ??= "state";
      return;
    }
    const currentFrameToken = ++frameToken;
    const resizeFrame = resizePending;
    resizePending = false;
    const totalStartedAt = performance.now();
    const now = Date.now();
    const fullscreen = state.mode === "MAP" || state.mode === "EDITOR"
      || (state.mode === "COMPOSE" && state.composer.fullscreen);
    const storyLayout = deriveStoryFrameLayout(renderer.width, state.config);
    const proseMeasure = storyProseMeasure(storyLayout.pageWidth);
    if (preparedProseMeasure !== null && preparedProseMeasure !== proseMeasure) {
      // Entries are keyed by measure, but retaining every width reached while
      // dragging a terminal multiplies the full-story cache without bound.
      wrapCache.invalidate();
    }
    preparedProseMeasure = proseMeasure;
    const layout = fullscreen
      ? singlePaneStoryFrameLayout(renderer.width)
      : storyLayout;
    const prepareStartedAt = performance.now();
    const coldState = cold.ensure(state, storyLayout);
    profile?.record("prepare", performance.now() - prepareStartedAt);
    if (coldState === "building") {
      const visibleOwner = loadingStoryId ?? paintedStoryId;
      if (!painted || visibleOwner !== state.payload.id || resizeFrame
        || failureRecovery === "claimed" && retryNeedsApplicationPaint) {
        const surfaceStartedAt = performance.now();
        paintLoadingFrame(state, renderer, surface, options.palette());
        retryNeedsApplicationPaint = false;
        profile?.record("surface", performance.now() - surfaceStartedAt);
        profile?.record("total", performance.now() - totalStartedAt);
        painted = true;
        loadingStoryId = state.payload.id;
        animations.schedule(null);
        onBuilt(version, false, currentFrameToken);
        requestPresentation(currentFrameToken, true);
      } else if (failureRecovery === "claimed") {
        // The retained surface still needs one exact native recovery attempt.
        // Keep it noninteractive until a complete current frame can replace it.
        onBuilt(version, false, currentFrameToken);
        requestPresentation(currentFrameToken, true);
      }
      return;
    }
    const deadlines = createFrameDeadlineCollector(now);
    const renderStartedAt = performance.now();
    const frame = renderStoryScreen({ ...state, now }, {
      width: renderer.width,
      height: renderer.height,
      wrapCache,
      layout,
      deadlines
    });
    profile?.record("render", performance.now() - renderStartedAt);
    const surfaceStartedAt = performance.now();
    surface.paint(
      frame.lines,
      options.palette(),
      layout,
      frame.selectable,
      state.mode === "SETTINGS"
        && (state.settings?.edit != null || state.settings?.sampling?.edit != null)
        ? { singleSelectionBuffer: true }
        : undefined
    );
    retryNeedsApplicationPaint = false;
    profile?.record("surface", performance.now() - surfaceStartedAt);
    Object.assign(state, frame.derived, { now });
    painted = true;
    paintedStoryId = state.payload.id;
    loadingStoryId = null;
    onBuilt(version, true, currentFrameToken);
    requestPresentation(currentFrameToken);
    animations.schedule(deadlines.next());
    profile?.record("total", performance.now() - totalStartedAt);
  }, {
    onError: (error) => reportFrameFailure(error, true)
  });
  const onNativeFrame = (event: CliRendererFrameEvent) => {
    const pending = pendingPresentation;
    if (pending === null || event.frameId < pending.minimumNativeFrameId) return;
    pendingPresentation = null;
    frameFailed = false;
    failureRecovery = "unclaimed";
    retryNeedsApplicationPaint = false;
    if (profile !== null && pending.invalidatedAt !== null) {
      profile.record("presentation", performance.now() - pending.invalidatedAt);
    }
    options.onPresented?.(pending.frameToken);
    const deferred = deferredFailureReason;
    deferredFailureReason = null;
    if (deferred !== null) requestFrame(deferred);
  };
  renderer.on(CliRenderEvents.FRAME, onNativeFrame);
  const flush = () => {
    // A failed scheduler attempt consumed its dirty bit. The next input may
    // claim one recovery; only its exact native FRAME releases that claim.
    if (frameFailed && failureRecovery === "unclaimed") {
      failureRecovery = "claimed";
      deferredFailureReason = null;
      scheduler.invalidate("state");
    }
    scheduler.flush();
  };

  return {
    invalidate(reason = "state") {
      version += 1;
      requestFrame(reason);
    },
    flush,
    requestInputRecovery() {
      if (!frameFailed || failureRecovery === "exhausted") return;
      flush();
    },
    dispose() {
      disposed = true;
      pendingPresentation = null;
      deferredFailureReason = null;
      renderer.off(CliRenderEvents.FRAME, onNativeFrame);
      animations.dispose();
      cold.dispose();
      scheduler.dispose();
    },
    profile: (native) => profile?.report(scheduler.stats(), cold.stats(), wrapCache, native) ?? null,
    get version() { return version; },
    get frameToken() { return frameToken; },
    get failed() { return frameFailed; },
    get inputRecoveryExhausted() { return failureRecovery === "exhausted"; }
  };
}

function paintLoadingFrame(
  state: RuntimeState,
  renderer: CliRenderer,
  surface: StorySurface,
  palette: Palette
): void {
  // OpenTUI reapplies a renderable's last local selection when its content
  // changes. Loading pixels are deliberately noninteractive, so retire the
  // old prose selection before the page buffer can remap it onto the loader.
  renderer.clearSelection();
  const lines: FrameLine[] = Array.from({ length: renderer.height }, () => []);
  const row = Math.max(0, Math.floor(renderer.height / 2));
  lines[row] = fitLine([
    segment("  opening ", "chrome"),
    segment(state.payload.title || "untitled story", "focus / accent"),
    segment("…", "chrome")
  ], renderer.width);
  state.hitRows = Array.from({ length: renderer.height }, () => null);
  surface.paint(lines, palette, singlePaneStoryFrameLayout(renderer.width), null, {
    pageSelectable: false
  });
}
