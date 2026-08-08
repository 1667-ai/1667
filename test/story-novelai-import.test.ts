import assert from "node:assert/strict";
import test from "node:test";
import {
  partsFromNovelAiStory,
  MAX_PARTS,
  MAX_RECORDS,
  MAX_TOTAL_CHARS
} from "../server/import-nai.js";
import { ServiceError } from "../server/errors.js";
import { alternatesFromNovelAiHistory } from "../server/import-nai-history.js";
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
  assert.equal(parsed.story.title, "Static Synthetic Story");
  assert.equal(parsed.story.parts.length, 2);
  assert.equal(parsed.story.parts[0]?.text, "Synthetic chapter 1 prose.");
  assert.equal(parsed.story.parts[1]?.text, "Synthetic chapter 2 prose.");
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
  assert.equal(parsed.story.title, "My NovelAI Story");
  assert.equal(parsed.story.parts.length, 2);
  assert.equal(parsed.story.parts[0]?.text, "First section text.");
  assert.equal(parsed.story.parts[1]?.text, "Second section text.");
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
  assert.equal(parsed.story.title, "😀".repeat(4096));
  assert.equal(parsed.story.parts[0]?.text, "Café prose.\nLine two.");
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
  assert.equal(parsed.story.title, "Legacy V1 Story");
  assert.equal(parsed.story.parts.length, 3);
  assert.equal(parsed.story.parts[0]?.text, "Line 1 of legacy story.");
  assert.equal(parsed.story.parts[1]?.text, "Line 2 of legacy story.");
  assert.equal(parsed.story.parts[2]?.text, "Line 3 of legacy story.");
});

test("partsFromNovelAiStory imports a V1 legacy datablocks retry as a sibling take, nested, off the active storyline", () => {
  // root(0) -> block1(1) -> A(2, chosen/current)
  //                       \> B(3, a retry) -> B2(4, a further retry of B)
  //                       \> edited(5, origin "edit" — not a simple continuation, dropped)
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Legacy V1 retry history" },
    content: {
      storyContentVersion: 1,
      story: {
        fragments: [
          { data: "Sec one.\n", origin: "ai" },
          { data: "Sec two.\n", origin: "ai" },
          { data: "Sec three (A).\n", origin: "ai" }
        ],
        currentBlock: 2,
        datablocks: [
          { prevBlock: -1, nextBlock: [1], startIndex: 0, dataFragment: { data: "Sec one.\n", origin: "ai" } },
          { prevBlock: 0, nextBlock: [2, 3, 5], startIndex: 9, dataFragment: { data: "Sec two.\n", origin: "ai" } },
          { prevBlock: 1, nextBlock: [], startIndex: 18, dataFragment: { data: "Sec three (A).\n", origin: "ai" } },
          { prevBlock: 1, nextBlock: [4], startIndex: 18, dataFragment: { data: "Sec four (B).\n", origin: "ai" } },
          { prevBlock: 3, nextBlock: [], startIndex: 32, dataFragment: { data: "Sec five (B2).", origin: "ai" } },
          { prevBlock: 1, nextBlock: [], startIndex: 18, dataFragment: { data: "Edited two.", origin: "edit" } }
        ]
      }
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.deepEqual(parsed.story.parts.map(({ text, parentIndex, active }) => ({ text, parentIndex, active })), [
    { text: "Sec one.", parentIndex: undefined, active: undefined },
    { text: "Sec two.", parentIndex: undefined, active: undefined },
    { text: "Sec three (A).", parentIndex: undefined, active: undefined },
    { text: "Sec four (B).", parentIndex: 1, active: false },
    { text: "Sec five (B2).", parentIndex: 3, active: false }
  ]);
  assert.deepEqual(parsed.fidelity, [
    "2 retries imported as unselected takes",
    "1 retry branch omitted: not a simple continuation",
    "generation settings omitted"
  ]);
});

test("partsFromNovelAiStory degrades a malformed V1 legacy history without touching the active prose", () => {
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Bad legacy history" },
    content: {
      storyContentVersion: 1,
      story: {
        fragments: [{ data: "Only active prose.", origin: "ai" }],
        // A block whose own prevBlock points back at itself is a cycle.
        currentBlock: 0,
        datablocks: [
          { prevBlock: 0, nextBlock: [], startIndex: 0, dataFragment: { data: "Only active prose.", origin: "ai" } }
        ]
      }
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Only active prose."]);
  assert.deepEqual(parsed.fidelity, ["retry history omitted: malformed", "generation settings omitted"]);
});

test("partsFromNovelAiStory omits a V1 retry that diverges inside one imported story part", () => {
  const containerJson = JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Mid-line retry" },
    content: {
      story: {
        fragments: [{ data: "Prompt selected.", origin: "ai" }],
        currentBlock: 1,
        datablocks: [
          { prevBlock: -1, nextBlock: [1, 2], startIndex: 0, dataFragment: { data: "Prompt ", origin: "prompt" } },
          { prevBlock: 0, nextBlock: [], startIndex: 7, dataFragment: { data: "selected.", origin: "ai" } },
          { prevBlock: 0, nextBlock: [], startIndex: 7, dataFragment: { data: "alternate.", origin: "ai" } }
        ]
      }
    }
  });

  const parsed = partsFromNovelAiStory(containerJson);
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Prompt selected."]);
  assert.deepEqual(parsed.fidelity, [
    "1 retry branch omitted: not a simple continuation",
    "generation settings omitted"
  ]);
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
  assert.equal(parsed.story.title, "Dirty Sections Story");
  assert.equal(parsed.story.parts.length, 3);
  assert.equal(parsed.story.parts[0]?.text, "Prepended Section");
  assert.equal(parsed.story.parts[1]?.text, "Hello Universe");
  assert.equal(parsed.story.parts[2]?.text, "Inserted Section");
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
  assert.equal(parsed.story.parts[0]?.text, "aXXcdYfghi");
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
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Base", "B", "A"]);
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
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Replacement"]);
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
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), [
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
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Only prose."]);
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
  assert.equal(parsed.story.parts.length, 2);
  assert.equal(parsed.story.parts[0]?.text, "Numeric 1 section");
  assert.equal(parsed.story.parts[1]?.text, "String 1 section");
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

test("partsFromNovelAiStory rejects large binary section maps before enumeration", () => {
  const binaryMap = Buffer.alloc(1_000_000);
  const asRecord = binaryMap as unknown as Record<string, unknown>;
  const documents = [
    {
      document: makeSyntheticNovelAiV2Base64(asRecord, []),
      message: "Malformed sections map"
    },
    {
      document: makeSyntheticNovelAiV2Base64(
        new Map([[1, { type: 1, text: "Prose." }]]),
        [1],
        asRecord
      ),
      message: "Malformed dirty sections map"
    }
  ];

  for (const { document, message } of documents) {
    assert.throws(
      () => partsFromNovelAiStory(JSON.stringify({
        storyContainerVersion: 1,
        metadata: { title: "Binary map" },
        content: { document }
      })),
      (error: unknown) => error instanceof ServiceError
        && error.status === 400
        && error.message === message
    );
  }
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
  assert.equal(fallbackParsed.story.title, "Imported NovelAI story");

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

test("partsFromNovelAiStory imports retry history as unselected takes, nested, off the active storyline", () => {
  // root -> checkpoint (sec 1, sec 2) -> A (sec 3, chosen/current)
  //                                   \> B (sec 4, a retry) -> B2 (sec 5, a further retry of B)
  //                                   \> C (edits sec 2 in place — not a simple continuation, dropped)
  const sections = new Map([
    [1, { type: 1, text: "Sec one." }],
    [2, { type: 1, text: "Sec two." }],
    [3, { type: 1, text: "Sec three (A)." }]
  ]);
  const history = {
    root: 100,
    current: 102,
    nodes: new Map([
      [100, {}],
      [101, { parent: 100, changes: new Map<number, unknown>([
        [1, { type: 0, section: { type: 1, text: "Sec one." } }],
        [2, { type: 0, section: { type: 1, text: "Sec two." }, after: 1 }]
      ]) }],
      [102, { parent: 101, changes: new Map<number, unknown>([
        [3, { type: 0, section: { type: 1, text: "Sec three (A)." }, after: 2 }]
      ]), date: "2025-06-01T00:00:00.000Z" }],
      [103, { parent: 101, changes: new Map<number, unknown>([
        [4, { type: 0, section: { type: 1, text: "Sec four (B)." }, after: 2 }]
      ]), date: "2025-06-02T00:00:00.000Z" }],
      [104, { parent: 103, changes: new Map<number, unknown>([
        [5, { type: 0, section: { type: 1, text: "Sec five (B2)." }, after: 4 }]
      ]), date: "2025-06-03T00:00:00.000Z" }],
      [105, { parent: 101, changes: new Map<number, unknown>([
        [2, { type: 1, diff: { parts: [{ from: 0, delete: "Sec two.", insert: "Edited." }] } }]
      ]) }]
    ])
  };
  const document = makeSyntheticNovelAiV2Base64(sections, [1, 2, 3], undefined, history);

  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Retry history" },
    content: { document }
  }));

  assert.deepEqual(parsed.story.parts.map(({ text, parentIndex, active }) => ({ text, parentIndex, active })), [
    { text: "Sec one.", parentIndex: undefined, active: undefined },
    { text: "Sec two.", parentIndex: undefined, active: undefined },
    { text: "Sec three (A).", parentIndex: undefined, active: undefined },
    { text: "Sec four (B).", parentIndex: 1, active: false },
    { text: "Sec five (B2).", parentIndex: 3, active: false }
  ]);
  assert.equal(parsed.story.parts[3]?.createdAt, "2025-06-02T00:00:00.000Z");
  assert.deepEqual(parsed.fidelity, [
    "2 retries imported as unselected takes",
    "1 retry branch omitted: not a simple continuation",
    "generation settings omitted"
  ]);
});

test("partsFromNovelAiStory degrades a malformed history without touching the active prose", () => {
  const document = makeSyntheticNovelAiV2Base64(
    new Map([[1, { type: 1, text: "Only active prose." }]]),
    [1],
    undefined,
    { root: 100, current: 999, nodes: new Map([[100, {}]]) }
  );
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "Bad history" },
    content: { document }
  }));
  assert.deepEqual(parsed.story.parts.map(({ text }) => text), ["Only active prose."]);
  assert.deepEqual(parsed.fidelity, ["retry history omitted: malformed", "generation settings omitted"]);
});

test("NovelAI V2 retry history walks a deep no-op branch without using the call stack", () => {
  const nodes = new Map<string, { parent?: string; changes: Map<unknown, unknown> }>();
  nodes.set("root", { changes: new Map() });
  let parent = "root";
  for (let index = 0; index < 20_000; index += 1) {
    const id = `no-op-${index}`;
    nodes.set(id, { parent, changes: new Map() });
    parent = id;
  }

  const imported = alternatesFromNovelAiHistory(
    { root: "root", current: "root", nodes },
    {
      parts: [{ instruction: "", text: "Active prose.", createdAt: "2026-01-01T00:00:00.000Z" }],
      sectionIndex: new Map(),
      room: MAX_PARTS - 1,
      charsRoom: MAX_TOTAL_CHARS - "Active prose.".length
    }
  );

  assert.deepEqual(imported, { parts: [], fidelity: [] });
});

test("partsFromNovelAiStory omits retries once the story is at the part limit", () => {
  const sections = new Map<number, unknown>();
  for (let id = 1; id <= MAX_PARTS; id += 1) sections.set(id, { type: 1, text: `Sec ${id}.` });
  const order = [...sections.keys()];
  const rootChanges = new Map<string | number, unknown>();
  let previous: number | undefined;
  for (const id of order) {
    rootChanges.set(id, { type: 0, section: { type: 1, text: `Sec ${id}.` }, after: previous });
    previous = id;
  }
  const historyNodes = new Map<string | number, { parent?: string; changes?: Map<string | number, unknown> }>([
    ["root", { changes: rootChanges }],
    ["retry", { parent: "root", changes: new Map([
      ["extra", { type: 0, section: { type: 1, text: "One too many." }, after: previous }]
    ]) }]
  ]);
  // The full document already carries `order`/`sections` at MAX_PARTS, so the
  // retry can only be reached through `history`, not through the active read.
  const document = makeSyntheticNovelAiV2Base64(sections, order, undefined, {
    root: "root",
    current: "root",
    nodes: historyNodes
  });
  const parsed = partsFromNovelAiStory(JSON.stringify({
    storyContainerVersion: 1,
    metadata: { title: "At the limit" },
    content: { document }
  }));
  assert.equal(parsed.story.parts.length, MAX_PARTS);
  assert.ok(parsed.fidelity.includes("retry takes stopped: story is at the part or text limit"));
});
