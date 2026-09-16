import assert from "node:assert/strict";
import test from "node:test";
import { REFERENCE_BINDINGS } from "../../tui/src/reference-bindings.js";
import { KEYS_MODAL_MODEL } from "../../tui/src/keys-reference-model.js";
import { COMMANDS, commandForAction, registryHasBinding } from "../renderer-commands.js";
import { commandKeyDisplay } from "../renderer-palette-view.js";

// No Electron here: the registry table is pure data, so a plain `node --test`
// run can check it against the TUI's own reference without a renderer.

test("every command with a binding names a reference binding that exists", () => {
  for (const command of COMMANDS) {
    if (command.binding === undefined) continue;
    assert.ok(command.binding in REFERENCE_BINDINGS, `${command.id} names an unknown binding "${command.binding}"`);
  }
});

test("every keys-sheet entry the desktop shows has a working command behind it", () => {
  let shown = 0;
  for (const section of KEYS_MODAL_MODEL.sections) {
    for (const entry of section.entries) {
      const supported = entry.bindings.filter((binding) => registryHasBinding(binding));
      if (supported.length === 0) continue;
      shown += 1;
      const runnable = supported.some((binding) =>
        commandForAction(binding.action, binding.mode === "MAP" ? "MAP" : "NAV") !== undefined);
      assert.ok(runnable, `entry "${entry.description}" is shown in the keys sheet but no command runs its binding`);
    }
  }
  // A loose floor: MOVE, WRITE, SHAPE, and most of OPEN should all show.
  assert.ok(shown > 15, `expected a substantial slice of the TUI reference to show, got ${shown} entries`);
});

test("the palette's key text matches the binding's own display", () => {
  for (const command of COMMANDS) {
    if (command.binding === undefined) continue;
    assert.equal(commandKeyDisplay(command), REFERENCE_BINDINGS[command.binding].display);
  }
});

test("no two commands claim the same binding", () => {
  const owners = new Map<string, string>();
  for (const command of COMMANDS) {
    if (command.binding === undefined) continue;
    const owner = owners.get(command.binding);
    assert.equal(owner, undefined, `binding "${command.binding}" is claimed by both "${owner}" and "${command.id}"`);
    owners.set(command.binding, command.id);
  }
});

test("no two commands answer to the same (mode, action)", () => {
  const owners = new Map<string, string>();
  for (const command of COMMANDS) {
    if (command.handles === undefined) continue;
    const key = `${command.handles.mode}:${command.handles.action}`;
    const owner = owners.get(key);
    assert.equal(owner, undefined, `"${key}" is claimed by both "${owner}" and "${command.id}"`);
    owners.set(key, command.id);
  }
});

test("every command id is unique", () => {
  const ids = COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the quit, typewriter, and log bindings stay unbound on the desktop", () => {
  for (const id of ["navQuit", "navTypewriter", "navOpenLog", "mapOpenLog"] as const) {
    assert.ok(!registryHasBinding(REFERENCE_BINDINGS[id]), `"${id}" must stay out of the desktop registry`);
  }
});
