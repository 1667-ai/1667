import { saveConfig, type UserConfig } from "./config.js";
import { withRememberedFocus } from "./reading-position.js";
import type { RuntimeState } from "./state.js";

const PERSIST_DEBOUNCE_MS = 400;

type FocusSource = {
  config: UserConfig;
  demo: boolean;
};

let pendingConfig: UserConfig | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Update in-memory reading position; durable write is debounced. */
export function rememberFocus(state: RuntimeState, source: FocusSource): void {
  if (source.demo || state.demo) return;
  const next = withRememberedFocus(
    state.config,
    state.payload,
    state.focusIndex,
    state.stream
  );
  if (next === state.config) return;
  state.config = next;
  source.config = next;
  queuePersist(next);
}

/** Flush a pending durable write (story switch, delete, shutdown). */
export function flushReadingPositionPersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingConfig === null) return;
  saveConfig(pendingConfig);
  pendingConfig = null;
}

function queuePersist(config: UserConfig): void {
  pendingConfig = config;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (pendingConfig === null) return;
    saveConfig(pendingConfig);
    pendingConfig = null;
  }, PERSIST_DEBOUNCE_MS);
}
