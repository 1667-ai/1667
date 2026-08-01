import assert from "node:assert/strict";
import test from "node:test";
import {
  partsFromNovelAiStory,
  MAX_PARTS,
  MAX_RECORDS,
  MAX_TOTAL_CHARS
} from "../server/import-nai.js";
import { ServiceError } from "../server/errors.js";
import {
  STATIC_SYNTHETIC_V2_BASE64,
  SyntheticNovelAiSectionDiff,
  SyntheticNovelAiTextDiff,
  makeSyntheticNovelAiV2Base64
} from "./novelai-fixture.js";

test("partsFromNovelAiStory decodes static synthetic extension 20 framed constant", () => {
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Static Synthetic Story" },
    content: {
      storyContentVersion: 6,
      document: STATIC_SYNTHETIC_V2_BASE64
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.title, "Static Synthetic Story");
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0]?.text, "Synthetic chapter 1 prose.");
  assert.equal(parsed.parts[1]?.text, "Synthetic chapter 2 prose.");
});

test("partsFromNovelAiStory parses V2 Editor document with Extension 20 and Map sections", () => {
  const sectionsMap = new Map<string | number, { type: number; text: string }>([
    ["sec-1", { type: 1, text: "First section text." }],
    ["sec-2", { type: 1, text: "Second section text." }]
  ]);
  const docBase64 = makeSyntheticNovelAiV2Base64(sectionsMap, ["sec-1", "sec-2"]);

  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "My NovelAI Story", createdAt: 1700000000000 },
    content: {
      storyContentVersion: 6,
      document: docBase64
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.title, "My NovelAI Story");
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0]?.text, "First section text.");
  assert.equal(parsed.parts[1]?.text, "Second section text.");
});

test("partsFromNovelAiStory normalizes NFC, line endings, and truncates title by Unicode scalar count", () => {
  const emojiTitle = "😀".repeat(4097);
  const sectionsMap = new Map([
    ["sec-1", { type: 1, text: "Cafe\u0301 prose.\r\nLine two." }]
  ]);
  const docBase64 = makeSyntheticNovelAiV2Base64(sectionsMap, ["sec-1"]);
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: emojiTitle },
    content: { document: docBase64 }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.title, "😀".repeat(4096));
  assert.equal(parsed.parts[0]?.text, "Café prose.\nLine two.");
});

test("partsFromNovelAiStory parses V1 Legacy fragments when document is absent", () => {
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Legacy V1 Story" },
    content: {
      storyContentVersion: 1,
      story: {
        fragments: [
          { data: "Line 1 of legacy story.\r\nLine 2 of legacy story.\r\n" },
          { data: "\r\nLine 3 of legacy story." }
        ]
      }
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.title, "Legacy V1 Story");
  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.parts[0]?.text, "Line 1 of legacy story.");
  assert.equal(parsed.parts[1]?.text, "Line 2 of legacy story.");
  assert.equal(parsed.parts[2]?.text, "Line 3 of legacy story.");
});

test("partsFromNovelAiStory applies dirtySections diffs correctly with chunk builder and bounds verification", () => {
  const sectionsMap = new Map([
    ["sec-1", { type: 1, text: "Hello World" }],
    ["sec-2", { type: 1, text: "ToRemove" }]
  ]);
  const dirtyMap = new Map<string | number, unknown>([
    // Create step with sentinel 0 (prepend)
    [
      "sec-0",
      {
        type: 0,
        section: { type: 1, text: "Prepended Section" },
        after: 0
      }
    ],
    // Create step
    [
      "sec-3",
      {
        type: 0,
        section: { type: 1, text: "Inserted Section" },
        after: "sec-1"
      }
    ],
    // Update step (text diff with verified delete and chunk builder)
    [
      "sec-1",
      {
        type: 1,
        diff: new SyntheticNovelAiSectionDiff(new SyntheticNovelAiTextDiff({
          parts: [{ from: 5, delete: " World", insert: " Universe" }]
        }))
      }
    ],
    // Remove step
    [
      "sec-2",
      {
        type: 2
      }
    ]
  ]);

  const docBase64 = makeSyntheticNovelAiV2Base64(sectionsMap, ["sec-1", "sec-2"], dirtyMap);
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Dirty Sections Story" },
    content: { document: docBase64 }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.title, "Dirty Sections Story");
  assert.equal(parsed.parts.length, 3);
  assert.equal(parsed.parts[0]?.text, "Prepended Section");
  assert.equal(parsed.parts[1]?.text, "Hello Universe");
  assert.equal(parsed.parts[2]?.text, "Inserted Section");
});

test("partsFromNovelAiStory applies successive text diff offsets to the evolving text", () => {
  const docBase64 = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "abcdefghi" }]]),
    [1],
    new Map([
      [1, {
        type: 1,
        diff: new SyntheticNovelAiSectionDiff(new SyntheticNovelAiTextDiff({
          parts: [
            { from: 1, delete: "b", insert: "XX" },
            { from: 2, delete: "e", insert: "Y" }
          ]
        }))
      }]
    ])
  );

  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Successive edits" },
    content: { document: docBase64 }
  }));
  assert.equal(parsed.parts[0]?.text, "aXXcdYfghi");
});

test("partsFromNovelAiStory resolves forward dirty-create anchors", () => {
  const document = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "Base" }]]),
    [1],
    new Map([
      [2, { type: 0, section: { type: 1, text: "A" }, after: 3 }],
      [3, { type: 0, section: { type: 1, text: "B" }, after: 1 }]
    ])
  );
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Forward anchors" },
    content: { document }
  }));
  assert.deepEqual(parsed.parts.map(({ text }) => text), ["Base", "B", "A"]);
});

test("partsFromNovelAiStory retains creates anchored to a pending removal", () => {
  const document = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "Removed base" }]]),
    [1],
    new Map([
      [2, {
        type: 0,
        section: { type: 1, text: "Replacement" },
        after: 1
      }],
      [1, {
        type: 2,
        previous: { type: 1, text: "Removed base" },
        after: 0
      }]
    ])
  );
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Removed anchor" },
    content: { document }
  }));
  assert.deepEqual(parsed.parts.map(({ text }) => text), ["Replacement"]);
});

test("partsFromNovelAiStory preserves dirty-create insertion semantics", () => {
  const document = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "Base" }]]),
    [1],
    new Map([
      [2, { type: 0, section: { type: 1, text: "Append A" } }],
      [3, { type: 0, section: { type: 1, text: "Append B" } }],
      [4, { type: 0, section: { type: 1, text: "Prepend A" }, after: 0 }],
      [5, { type: 0, section: { type: 1, text: "Prepend B" }, after: 0 }],
      [6, { type: 0, section: { type: 1, text: "After A" }, after: 1 }],
      [7, { type: 0, section: { type: 1, text: "After B" }, after: 1 }]
    ])
  );
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Create order" },
    content: { document }
  }));
  assert.deepEqual(parsed.parts.map(({ text }) => text), [
    "Prepend B",
    "Prepend A",
    "Base",
    "After B",
    "After A",
    "Append A",
    "Append B"
  ]);
});

test("partsFromNovelAiStory skips valid non-prose and whitespace sections", () => {
  const docBase64 = makeSyntheticNovelAiV2Base64(
    new Map([
      [1, { type: 0 }],
      [2, { type: 1, text: " \r\n\t" }],
      [3, { type: 2, source: "synthetic-image" }],
      [4, { type: 1, text: "Only prose." }]
    ]),
    [1, 2, 3, 4]
  );
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Mixed sections" },
    content: { document: docBase64 }
  }));
  assert.deepEqual(parsed.parts.map(({ text }) => text), ["Only prose."]);
});

test("partsFromNovelAiStory preserves type identity for numeric and string IDs", () => {
  const sectionsMap = new Map<string | number, unknown>([
    [1, { type: 1, text: "Numeric 1 section" }],
    ["1", { type: 1, text: "String 1 section" }]
  ]);
  const docBase64 = makeSyntheticNovelAiV2Base64(sectionsMap, [1, "1"]);

  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Type Identity Story" },
    content: { document: docBase64 }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0]?.text, "Numeric 1 section");
  assert.equal(parsed.parts[1]?.text, "String 1 section");
});

test("partsFromNovelAiStory enforces strict base64 validation rules", () => {
  const container = (doc: string) =>
    JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Base64 Test" },
      content: { document: doc }
    });

  // Non-canonical padding / junk
  assert.throws(
    () => partsFromNovelAiStory(container("NOT_VALID_BASE64!")),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  assert.throws(
    () => partsFromNovelAiStory(container("YWJj=")),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  assert.throws(
    () => partsFromNovelAiStory(container("YWJj\nYWJj")),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
  assert.throws(
    () => partsFromNovelAiStory(container(Buffer.from([0xc7, 1, 20, 0]).toString("base64"))),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});

test("partsFromNovelAiStory rejects missing references and malformed diffs", () => {
  const container = (docBase64: string) =>
    JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Error Test" },
      content: { document: docBase64 }
    });

  // Order references section absent from sections
  const missingRefDoc = makeSyntheticNovelAiV2Base64(
    new Map([["sec-1", { type: 1, text: "Prose" }]]),
    ["sec-1", "sec-missing"]
  );
  assert.throws(
    () => partsFromNovelAiStory(container(missingRefDoc)),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  const unorderedSectionDoc = makeSyntheticNovelAiV2Base64(
    new Map([
      [1, { type: 1, text: "Ordered" }],
      [2, { type: 1, text: "Unordered" }]
    ]),
    [1]
  );
  assert.throws(
    () => partsFromNovelAiStory(container(unorderedSectionDoc)),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  // Corrupt diff: deleted text mismatch
  const badDiffDoc = makeSyntheticNovelAiV2Base64(
    new Map([["sec-1", { type: 1, text: "Hello World" }]]),
    ["sec-1"],
    new Map([
      ["sec-1", { type: 1, diff: { parts: [{ from: 0, delete: "WrongText", insert: "New" }] } }]
    ])
  );
  assert.throws(
    () => partsFromNovelAiStory(container(badDiffDoc)),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  const cyclicCreateDoc = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "Base" }]]),
    [1],
    new Map([
      [2, { type: 0, section: { type: 1, text: "A" }, after: 3 }],
      [3, { type: 0, section: { type: 1, text: "B" }, after: 2 }]
    ])
  );
  assert.throws(
    () => partsFromNovelAiStory(container(cyclicCreateDoc)),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});

test("partsFromNovelAiStory enforces structural bounds and budgets", () => {
  // 1. Invalid storyContainerVersion
  assert.throws(
    () => partsFromNovelAiStory(JSON.stringify({ storyContainerVersion: 2, metadata: {}, content: {} })),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  // 2. Unpaired surrogate in title
  assert.throws(
    () => partsFromNovelAiStory(JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "\uD800" },
      content: { story: { fragments: [{ data: "prose" }] } }
    })),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  // 3. Fallback title on missing/empty title
  const fallbackParsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "   " },
    content: { story: { fragments: [{ data: "prose" }] } }
  }));
  assert.equal(fallbackParsed.title, "Imported NovelAI story");

  // 4. Duplicate JSON keys
  assert.throws(
    () => partsFromNovelAiStory(`{"storyContainerVersion":1,"metadata":{},"content":{},"content":{}}`),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  // 5. Exceeding max records limit
  const hugeOrder = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => `sec-${i}`);
  const hugeDocBase64 = makeSyntheticNovelAiV2Base64(new Map(), hugeOrder);
  assert.throws(
    () => partsFromNovelAiStory(JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Huge" },
      content: { document: hugeDocBase64 }
    })),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  const tooManyParts = new Map<number, unknown>();
  for (let id = 1; id <= MAX_PARTS + 1; id += 1) {
    tooManyParts.set(id, { type: 1, text: "x" });
  }
  const tooManyPartsDoc = makeSyntheticNovelAiV2Base64(
    tooManyParts,
    [...tooManyParts.keys()]
  );
  assert.throws(
    () => partsFromNovelAiStory(JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Too many parts" },
      content: { document: tooManyPartsDoc }
    })),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );

  const tooMuchTextDoc = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "x".repeat(MAX_TOTAL_CHARS + 1) }]]),
    [1]
  );
  assert.throws(
    () => partsFromNovelAiStory(JSON.stringify({
      storyContainerVersion: 1,
      metadata: { title: "Too much text" },
      content: { document: tooMuchTextDoc }
    })),
    (error: unknown) => error instanceof ServiceError && error.status === 400
  );
});

test("partsFromNovelAiStory preflights compact MessagePack amplification", () => {
  const container = (bytes: Buffer) => JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Bounded decode" },
    content: { document: bytes.toString("base64") }
  });

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
