import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// These assertions moved here from the homepage, which used to own the tape.
// The tape drives this repository's TUI through its demo fixture, so the flow
// it records is this repository's claim to keep true. The homepage stays the
// consumer: it holds the rendered MP4 and samples pixels at chapter timestamps
// measured against this recording.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tape = readFileSync(join(root, "scripts/demo.tape"), "utf8");

test("the demo tape records the real product flow", () => {
  assert.match(tape, /bun start -- --demo/);
  assert.match(tape, /Type "let the unlit lantern answer"/);
  assert.match(tape, /Wait\+Screen \/lantern flame bent\/\nSleep 3\.8s/);
  assert.match(
    tape,
    /Wait\+Screen \/lantern flame bent\/[\s\S]*Up[\s\S]*Up[\s\S]*Left[\s\S]*Right/
  );
  assert.match(tape, /Type "m"[\s\S]*Up[\s\S]*Down[\s\S]*Left[\s\S]*Right[\s\S]*Escape/);
  assert.equal(tape.match(/Type "m"/g)?.length, 1);
  assert.match(tape, /Type "\?"/);
});

test("the demo tape pins the capture geometry the homepage measured against", () => {
  // The homepage embeds the MP4 at 1280x720 and asserts that width and height
  // in its own markup, and its chapter seeks were measured at this framerate.
  // A change here silently invalidates timestamps in the other repository.
  assert.match(tape, /Set FontFamily "Berkeley Mono"/);
  assert.match(tape, /Set FontSize 16/);
  assert.match(tape, /Set LetterSpacing 0/);
  assert.match(tape, /Set Width 1280/);
  assert.match(tape, /Set Height 720/);
  assert.match(tape, /Set Framerate 24/);
});

test("the demo tape writes both artifacts the render script derives from", () => {
  assert.match(tape, /^Output demo-out\/1667-demo\.mp4$/m);
  assert.match(tape, /^Screenshot demo-out\/1667-demo-poster\.png$/m);

  const script = readFileSync(join(root, "scripts/render-demo.sh"), "utf8");
  assert.match(script, /vhs scripts\/demo\.tape/);
  assert.match(script, /-t 20/, "the README GIF is cut to twenty seconds");
  assert.match(script, /scale=800:-1/, "the README GIF is 800px wide");
});
