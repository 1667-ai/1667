import type { CliRenderer } from "@opentui/core";
import type { ActionRunner } from "./action-runtime.js";
import type { ThemeName } from "./config.js";
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

/** Runtime services that user-action dispatch does not own. */
export interface ActionLifecycle {
  readonly restartUpdateCheck: () => void;
}

export const INERT_ACTION_LIFECYCLE: ActionLifecycle = Object.freeze({
  restartUpdateCheck: () => undefined
});

export type BackendActionContext = Pick<ActionContext, "backend" | "cache">;
