#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron") as string;
execFileSync(electron, ["--input-type=module", "--eval", `
  import assert from "node:assert/strict";
  import { version } from "koffi";
  import { pack, unpack, isNativeAccelerationEnabled } from "msgpackr";
  import { get_encoding } from "tiktoken";
  import photon from "@silvia-odwyer/photon-node";
  assert.ok(version);
  assert.equal(isNativeAccelerationEnabled, true, "msgpackr native prebuild did not load");
  const value = { text: "A native desktop round trip.", values: [1, 2, 3] };
  assert.deepEqual(unpack(pack(value)), value);
  const encoding = get_encoding("cl100k_base");
  try { assert.ok(encoding.encode(value.text).length > 0); }
  finally { encoding.free(); }
  const image = new photon.PhotonImage(new Uint8Array([255, 128, 0, 255]), 1, 1);
  try { assert.ok(image.get_bytes().length > 0); }
  finally { image.free(); }
  console.log("Electron loaded Koffi, native MessagePack, tokenizer WASM, and image WASM.");
`], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit"
});
