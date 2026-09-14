import assert from "node:assert/strict";
import test from "node:test";
import { loadNodeFfi } from "../server/node-ffi.js";

test("Node FFI copies native bytes into memory supported by Electron", () => {
  const ffi = loadNodeFfi();
  const native = Uint8Array.from([11, 22, 33, 44]);
  const copy = new Uint8Array(ffi.toArrayBuffer(ffi.ptr(native), 1, 2));
  assert.deepEqual([...copy], [22, 33]);
  native.fill(0);
  assert.deepEqual([...copy], [22, 33]);
});
