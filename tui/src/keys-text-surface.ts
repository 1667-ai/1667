import type { KeyEvent } from "@opentui/core";
import type { ResolvedKey } from "./keys.js";

/**
 * The three composer-backed surfaces use these editing gestures.
 * They are Direct, the full-screen editor, and the settings fields.
 * They move and delete by character, word, and line.
 *
 * Four other surfaces hold a plain string, not a composer: the LIBRARY
 * prompt, the FACTS filter, the CHAPTERS rename field, and the TAG name.
 * These surfaces use `applyTextKey`. They do not use this table.
 *
 * Each surface checks its own chords before it checks this table.
 * This order keeps the intentional differences.
 * For example, `⌃f` controls fullscreen in Direct.
 * The same chord moves the cursor in the editor.
 * Return null when this table does not handle the key.
 *
 * The `extendSelection` flag changes a motion into a selection.
 */
export function textSurfaceKey(key: KeyEvent): ResolvedKey | null {
  const name = key.name.toLowerCase();
  // Terminals deliver alt as either, and neither is cmd — that arrives as
  // `super`, which no surface reads as a motion.
  const alt = key.meta || key.option;
  const byWord = key.ctrl || alt;
  const extend = key.shift ? { extendSelection: true } : {};

  if (key.name === "left") {
    return { action: byWord ? "cursor-word-left" : "cursor-left", ...extend };
  }
  if (key.name === "right") {
    return { action: byWord ? "cursor-word-right" : "cursor-right", ...extend };
  }
  if (key.name === "home") {
    return { action: key.ctrl ? "cursor-buffer-start" : "cursor-line-start", ...extend };
  }
  if (key.name === "end") {
    return { action: key.ctrl ? "cursor-buffer-end" : "cursor-line-end", ...extend };
  }

  // ctrl+backspace reaches us as a bare BS byte carrying no modifier, so it
  // cannot be told from plain backspace. alt does arrive, and ctrl+w is the
  // word delete that lands in every terminal.
  if (key.name === "backspace") {
    return { action: byWord ? "delete-word-left" : "backspace" };
  }
  if (key.name === "delete") {
    return { action: byWord ? "delete-word-right" : "delete-forward" };
  }
  if (key.ctrl && name === "w") return { action: "delete-word-left" };
  if (key.ctrl && name === "k") return { action: "delete-line-end" };
  if (key.ctrl && name === "u") return { action: "delete-line-start" };

  // Emacs line motion, which the full-screen editor has always answered.
  if (key.ctrl && name === "a") return { action: "cursor-line-start", ...extend };
  if (key.ctrl && name === "e") return { action: "cursor-line-end", ...extend };
  if (alt && name === "a") return { action: "cursor-line-start", ...extend };
  if (alt && name === "e") return { action: "cursor-line-end", ...extend };
  if (alt && name === "b") return { action: "cursor-word-left", ...extend };
  if (alt && name === "f") return { action: "cursor-word-right", ...extend };

  return null;
}
