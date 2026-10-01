/** True on Apple platforms, where the command key (⌘) is the shortcut key. Only
 * hover texts read it; the key handlers accept either ⌘ or Ctrl. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
