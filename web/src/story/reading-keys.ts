/** The key actions `StoryView.tsx` handles itself (the reading keys); keys
 * help lists only handled actions. The writing and structure keys have their
 * own lists beside their handlers. */
export const READING_KEY_ACTIONS: readonly string[] = [
  "focus-previous", "focus-next", "top", "leaf", "chapter-previous", "chapter-next",
  "toggle-instructions", "take-previous", "take-next", "continue",
  "scroll-line-up", "scroll-line-down", "scroll-up", "scroll-down",
  "open-library", "open-map", "open-settings", "toggle-context-meter"
];

export const NOTHING_TO_MAP_TOAST = "Nothing to map yet.";
