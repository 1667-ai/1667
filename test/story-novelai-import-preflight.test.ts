import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import {
  MAX_NOVELAI_JSON_VALUES,
  partsFromNovelAiStory
} from "../server/import-nai.js";

const container = (bytes: Buffer) => JSON.stringify({
  storyContainerVersion: 1,
  metadata: { title: "Bounded decode" },
  content: { document: bytes.toString("base64") }
});

test("NovelAI MessagePack preflight bounds containers, depth, and values", () => {
  const oversizedContainer = Buffer.from([
    0xd4, 20, 0,
    0xdd, 0, 0, 0xc3, 0x51
  ]);
  assert.throws(
    () => partsFromNovelAiStory(container(oversizedContainer)),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("more than 50000 items")
  );

  const deeplyNested = Buffer.from([
    0xd4, 20, 0,
    ...Array.from({ length: 129 }, () => 0x91),
    0xc0
  ]);
  assert.throws(
    () => partsFromNovelAiStory(container(deeplyNested)),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("nested too deeply")
  );

  const manyValues = Buffer.alloc(8 + 50_000 * 11, 0xc0);
  manyValues.set([0xd4, 20, 0, 0xdd, 0, 0, 0xc3, 0x50]);
  for (let offset = 8; offset < manyValues.length; offset += 11) {
    manyValues[offset] = 0x9a;
  }
  assert.throws(
    () => partsFromNovelAiStory(container(manyValues)),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("too many values")
  );
});

test("NovelAI MessagePack preflight bounds repeated bundled-string decoding", () => {
  const references = 50_000;
  const textBytes = 400;
  const bytes = Buffer.alloc(8 + references * 7 + 3 + textBytes + 1, 0x78);
  bytes.set([0xd4, 20, 0, 0xdd, 0, 0, 0xc3, 0x50]);
  const bundleStart = 8 + references * 7;
  for (let index = 0; index < references; index += 1) {
    const wrapperStart = 8 + index * 7;
    bytes.set([0xd6, 0x62], wrapperStart);
    bytes.writeUInt32BE(bundleStart - wrapperStart - 2, wrapperStart + 2);
    bytes[wrapperStart + 6] = 0xc0;
  }
  bytes.set([0xda, textBytes >> 8, textBytes & 0xff], bundleStart);
  bytes[bundleStart + 3 + textBytes] = 0xa0;

  assert.throws(
    () => partsFromNovelAiStory(container(bytes)),
    (error: unknown) => error instanceof ServiceError
      && error.status === 400
      && error.message.includes("bundled strings exceed")
  );
});

test("NovelAI container parsing bounds values in ignored metadata", () => {
  const ignoredValues = `${"null,".repeat(MAX_NOVELAI_JSON_VALUES)}null`;
  const json = `{"storyContainerVersion":1,"metadata":{"ignored":[${ignoredValues}]},`
    + `"content":{"story":{"fragments":[{"data":"prose"}]}}}`;

  assert.throws(
    () => partsFromNovelAiStory(json),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});
