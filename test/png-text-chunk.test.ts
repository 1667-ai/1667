import assert from "node:assert/strict";
import test from "node:test";
import { readPngTextChunk } from "../shared/png-text-chunk.js";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("readPngTextChunk refuses zTXt, iTXt, duplicate keyword, missing IEND, and non-ASCII metadata", () => {
  const payload = Buffer.from(JSON.stringify({ test: "data" }), "utf8").toString("base64");

  // Compressed zTXt for keyword
  const ztxt = png(chunk("zTXt", asciiBytes("naidata\0x")));
  assert.throws(() => readPngTextChunk(ztxt, "naidata"), /Compressed/);

  // Compressed iTXt for keyword
  const itxt = png(chunk("iTXt", asciiBytes("naidata\0x")));
  assert.throws(() => readPngTextChunk(itxt, "naidata"), /Compressed/);

  // Duplicate keyword
  const dup = png(textChunk("naidata", payload), textChunk("naidata", payload));
  assert.throws(() => readPngTextChunk(dup, "naidata"), /duplicate naidata/);

  // Missing IEND
  const missingEnd = concat(PNG_SIGNATURE, textChunk("naidata", payload));
  assert.throws(() => readPngTextChunk(missingEnd, "naidata"), /missing its IEND/);

  // Non-ASCII metadata in payload
  const nonAsciiPayload = chunk("tEXt", Uint8Array.from([...asciiBytes("naidata\0"), 0xe9, 0xff]));
  assert.throws(() => readPngTextChunk(png(nonAsciiPayload), "naidata"), /not valid ASCII/);

  // Successful read
  const valid = png(textChunk("naidata", payload));
  assert.equal(readPngTextChunk(valid, "naidata"), JSON.stringify({ test: "data" }));

  // Unrelated PNG return null
  const noMatch = png(textChunk("chara", payload));
  assert.equal(readPngTextChunk(noMatch, "naidata"), null);
});

function textChunk(keyword: string, value: string): Uint8Array {
  return chunk("tEXt", asciiBytes(`${keyword}\0${value}`));
}

function png(...chunks: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks, chunk("IEND", new Uint8Array()));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length);
  new DataView(output.buffer).setUint32(0, data.length, false);
  output.set(asciiBytes(type), 4);
  output.set(data, 8);
  return output;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
