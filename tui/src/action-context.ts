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

export type BackendActionContext = Pick<ActionContext, "backend" | "cache">;
