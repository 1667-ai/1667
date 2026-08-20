import type { CliRenderer } from "@opentui/core";
import type { ActionRunner } from "./action-runtime.js";
import type { ThemeName, UserConfig } from "./config.js";
import type { ProseStyle, WrapCache } from "./wrap.js";

/** Shared capabilities passed through every user-action reducer. */
export interface ActionContext {
  cache: WrapCache<ProseStyle>;
  repaint: () => void;
  backend: ActionRunner;
  renderer: CliRenderer | null;
  applyTheme: (theme: ThemeName) => void;
  previewTheme: (theme: ThemeName | null) => void;
  /** Test seam for the release-wide Aside switch. */
  asideEntryPointsOpen?: boolean;
}

/** Live update-check control used only by Settings actions. */
export interface UpdateCheckLifecycle {
  readonly restartUpdateCheck: (config: UserConfig) => void;
}

/** Optional UI services plus the required local lifecycle for one dispatch. */
export interface ActionDispatchServices {
  readonly updateChecks: UpdateCheckLifecycle;
  readonly renderer?: ActionContext["renderer"];
  readonly applyTheme?: ActionContext["applyTheme"];
  readonly previewTheme?: ActionContext["previewTheme"];
  readonly backend?: ActionRunner;
}

export type OverlayActionContext = ActionContext & {
  readonly updateChecks: UpdateCheckLifecycle;
};

/** Explicit inert capability for render-only and unrelated test actions. */
export const INERT_UPDATE_CHECK_LIFECYCLE: UpdateCheckLifecycle = Object.freeze({
  restartUpdateCheck: () => undefined
});

export type BackendActionContext = Pick<ActionContext, "backend" | "cache">;
