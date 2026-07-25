import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  STARTER_KEYS,
  type StarterKey,
  type StarterKeyId
} from "../../shared/starter-keys.js";
import { STARTER_STORIES } from "../../shared/starter-vault.js";
import { resolveKey } from "../src/keys.js";
import { KEYS_MODAL_MODEL } from "../src/screens/keys-modal.js";

function key(name: string, options: { shift?: boolean; ctrl?: boolean } = {}): KeyEvent {
  const shift = options.shift ?? false;
  return {
    name,
    // Terminals deliver a shifted letter as its capital; the resolver accepts
    // that spelling, and the starter prose promises it.
    sequence: shift && /^[a-z]$/.test(name) ? name.toUpperCase() : name,
    shift,
    ctrl: options.ctrl ?? false,
    meta: false,
    super: false
  } as KeyEvent;
}

// `as const satisfies` narrows each entry to its own literal shape, which drops
// the optional modifiers. Widen back to the declared interface.
const declared = Object.entries(STARTER_KEYS) as [StarterKeyId, StarterKey][];

describe("starter vault key contract", () => {
  test("every key the starter stories teach still resolves to an action", () => {
    for (const [id, binding] of declared) {
      const event = key(binding.name, {
        ...(binding.shift === true ? { shift: true } : {}),
        ...(binding.ctrl === true ? { ctrl: true } : {})
      });
      const resolved = resolveKey(event, binding.mode, {
        ...(binding.mapView === undefined ? {} : { mapView: binding.mapView })
      });
      expect(`${id}:${resolved.action}`).not.toBe(`${id}:none`);
    }
  });

  test("the tour and the keys overlay agree wherever both describe a key", () => {
    // The overlay is the in-app reference and the tour is the narrated one.
    // The overlay does not advertise every binding the resolver honours (the
    // shifted-arrow scroll, for one), so absence is allowed — disagreement is
    // not.
    let compared = 0;
    for (const [id, binding] of declared) {
      const event = key(binding.name, {
        ...(binding.shift === true ? { shift: true } : {}),
        ...(binding.ctrl === true ? { ctrl: true } : {})
      });
      const resolved = resolveKey(event, binding.mode, {
        ...(binding.mapView === undefined ? {} : { mapView: binding.mapView })
      });
      for (const advertised of KEYS_MODAL_MODEL.bindings) {
        if (advertised.name !== binding.name
          || advertised.mode !== binding.mode
          || (advertised.shift ?? false) !== (binding.shift ?? false)
          || (advertised.ctrl ?? false) !== (binding.ctrl ?? false)
          || (advertised.mapView ?? binding.mapView) !== binding.mapView) continue;
        compared += 1;
        expect(`${id}:${advertised.action}`).toBe(`${id}:${resolved.action}`);
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  test("prose declares a key for every bracketed token it shows", () => {
    for (const story of STARTER_STORIES) {
      for (const beat of story.beats) {
        for (const take of beat.takes) {
          const allowed = new Set<string>((take.keys ?? []).map((id) => STARTER_KEYS[id].token));
          for (const match of take.text.matchAll(/\[([^\]]+)\]/g)) {
            expect(`${take.slug}:${allowed.has(match[1]!)}`).toBe(`${take.slug}:true`);
          }
        }
      }
    }
  });
});
