import { addHit, type HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import {
  plainLine,
  visibleWidth,
  type FrameLine
} from "./story/frame.js";

export interface HintToken {
  text: string;
  action?: KeyAction;
  /** Glyph pairs (`↑↓`, `←→`) whose two cells run different actions. */
  pair?: readonly [KeyAction, KeyAction];
}

export function joinHintTokens(tokens: readonly HintToken[], separator: string): string {
  return tokens.map((token) => token.text).join(separator);
}

/** Register every footer key drawn on the bottom row. The scan starts at
 * the hint itself: a bare token like `m` would otherwise match a letter of the
 * story title sitting to its left on the same row. */
export function addFooterHits(
  hitRows: HitRows,
  lines: FrameLine[],
  height: number,
  tokens: readonly HintToken[],
  anchor: string
): void {
  const footerRow = Math.min(height, lines.length) - 1;
  if (footerRow < 0) return;
  const text = plainLine(lines[footerRow] ?? []);
  let offset = text.lastIndexOf(anchor);
  if (offset === -1) return;
  for (const token of tokens) {
    const index = text.indexOf(token.text, offset);
    if (index === -1) continue;
    offset = index + token.text.length;
    const left = visibleWidth(text.slice(0, index));
    if (token.pair !== undefined) {
      addHit(hitRows, footerRow, { target: { kind: "action", action: token.pair[0] }, left, right: left + 1 });
      addHit(hitRows, footerRow, {
        target: { kind: "action", action: token.pair[1] }, left: left + 1, right: left + 2
      });
    } else if (token.action !== undefined) {
      addHit(hitRows, footerRow, {
        target: { kind: "action", action: token.action },
        left,
        right: left + visibleWidth(token.text)
      });
    }
  }
}
