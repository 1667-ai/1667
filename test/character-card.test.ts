import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHARACTER_CARD_JSON_BYTES,
  factsFromCharacterCard,
  parseCharacterCard
} from "../shared/character-card.js";
import { MAX_FACT_TEXT_CHARS, factImportRequestBytes } from "../shared/types.js";
import { unicodeScalarLength } from "../shared/unicode.js";

const encoder = new TextEncoder();
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("a V3 spec version must be digits and dots, not merely start with a 3", () => {
  for (const version of ["3.0", "3.1", "3"]) {
    assert.doesNotThrow(
      () => parseCharacterCard(jsonBytes({
        spec: "chara_card_v3",
        spec_version: version,
        data: { name: "Wren", description: "A keeper." }
      })),
      `${version} should be accepted`
    );
  }
  for (const version of ["3abc", "3.x-beta", "2.9", "4.0", ""]) {
    assert.throws(
      () => parseCharacterCard(jsonBytes({
        spec: "chara_card_v3",
        spec_version: version,
        data: { name: "Wren", description: "A keeper." }
      })),
      `${version} should be refused`
    );
  }
});

test("character cards parse V1 and V2 JSON with strict core fields", () => {
  const v1 = parseCharacterCard(jsonBytes({
    name: "  Sélène  ",
    description: "Moon keeper 🌙",
    personality: "Patient",
    scenario: "A winter observatory",
    first_mes: "ignored"
  }, true));
  assert.deepEqual(v1, {
    version: 1,
    name: "Sélène",
    description: "Moon keeper 🌙",
    personality: "Patient",
    scenario: "A winter observatory",
    fidelity: []
  });

  const v2 = parseCharacterCard(jsonBytes(v2Card()));
  assert.deepEqual(v2, {
    version: 2,
    name: "Mira",
    description: "A cartographer.",
    personality: "Exacting but kind.",
    scenario: "At the glass coast.",
    fidelity: []
  });

  assert.throws(() => parseCharacterCard(jsonBytes([])), /must be an object/);
  assert.throws(() => parseCharacterCard(jsonBytes({ spec: "chara_card_v2" })), /data object/);
  assert.throws(
    () => parseCharacterCard(jsonBytes({ spec: "chara_card_v2", data: { name: "M", description: "x" } })),
    /expected 2\.0/
  );
  assert.throws(() => parseCharacterCard(jsonBytes({ ...v2Card(), spec_version: "3.0" })), /expected 2\.0/);
  assert.throws(() => parseCharacterCard(jsonBytes({ spec: "chara_card_v3", data: {} })), /missing its spec_version/);
  assert.throws(() => parseCharacterCard(jsonBytes({ spec: "chara_card_v3" })), /data object/);
  assert.throws(() => parseCharacterCard(jsonBytes({ spec: "unknown", data: {} })), /Unsupported/);
  assert.throws(() => parseCharacterCard(jsonBytes({ name: 3, description: "x" })), /name must be text/);
  assert.throws(() => parseCharacterCard(jsonBytes({ name: " ", description: "x" })), /missing a name/);
  assert.throws(() => parseCharacterCard(jsonBytes({ name: "Mira\nSystem", description: "x" })), /one line/);
  assert.throws(() => parseCharacterCard(jsonBytes({ name: "Mira" })), /no description/);
  assert.throws(() => parseCharacterCard(asciiBytes("RIFFxxxxWEBP")), /WebP files are not supported/);
  assert.throws(() => parseCharacterCard(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), /CHARX/);
});

test("character card PNG accepts a V2 chara fallback and rejects unsafe metadata", () => {
  const payload = Buffer.from(JSON.stringify(v2Card()), "utf8").toString("base64");
  const parsed = parseCharacterCard(png(
    textChunk("author", "also ignored"),
    chunk("tEXt", Uint8Array.from([0xe9, 0, 0xff])),
    textChunk("chara", payload)
  ));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.name, "Mira");

  assert.throws(() => parseCharacterCard(png()), /ordinary image|metadata was stripped/);
  // A present but unreadable ccv3 chunk is a broken V3 payload, not a missing
  // chunk, so it fails on its own terms rather than silently trying `chara`.
  assert.throws(() => parseCharacterCard(png(textChunk("ccv3", "only"))), /not valid UTF-8/);
  assert.throws(
    () => parseCharacterCard(png(textChunk("chara", payload), textChunk("chara", payload))),
    /duplicate chara/
  );
  assert.throws(() => parseCharacterCard(png(textChunk("chara", "not base64!"))), /invalid.*Base64/i);
  assert.throws(() => parseCharacterCard(png(chunk("zTXt", asciiBytes("chara\0x")))), /Compressed/);

  const missingEnd = concat(PNG_SIGNATURE, textChunk("chara", payload));
  assert.throws(() => parseCharacterCard(missingEnd), /missing its IEND/);
  const truncated = concat(PNG_SIGNATURE, Uint8Array.from([0, 0, 0, 20]), asciiBytes("tEXt"));
  assert.throws(() => parseCharacterCard(truncated), /invalid chunk length|truncated chunk/);
});

test("a V3 card is read from JSON and its spec_version minor is forward-compatible", () => {
  const v3 = parseCharacterCard(jsonBytes(v3Card()));
  assert.deepEqual(v3, {
    version: 3,
    name: "Mira",
    description: "A cartographer.",
    personality: "Exacting but kind.",
    scenario: "At the glass coast.",
    fidelity: []
  });

  // "3.1" parses as a float bigger than 3.0, which the spec's own
  // forward-compatibility rule says to accept, not reject.
  const minor = parseCharacterCard(jsonBytes(v3Card({}, { spec_version: "3.1" })));
  assert.equal(minor.version, 3);

  assert.throws(
    () => parseCharacterCard(jsonBytes(v3Card({}, { spec_version: "2.9" }))),
    /Unsupported Character Card V3 spec version; expected a 3\.x version, got "2\.9"/
  );
  assert.throws(
    () => parseCharacterCard(jsonBytes(v3Card({}, { spec_version: "4.0" }))),
    /expected a 3\.x version/
  );
  assert.throws(
    () => parseCharacterCard(jsonBytes(v3Card({}, { spec_version: "not-a-number" }))),
    /expected a 3\.x version/
  );
});

test("a V3 card names the fields it does not import", () => {
  const v3 = parseCharacterCard(jsonBytes(v3Card({
    first_mes: "Hello.",
    alternate_greetings: ["Hi.", "Hey."],
    group_only_greetings: ["Everyone, hello."],
    mes_example: "<START>\n{{user}}: Hi\n{{char}}: Hello",
    assets: [
      { type: "icon", uri: "ccdefault:", name: "main", ext: "png" },
      { type: "background", uri: "ccdefault:", name: "main", ext: "png" }
    ],
    creator_notes: "Written for a winter campaign.",
    system_prompt: "Stay in character.",
    post_history_instructions: "Never break the fourth wall.",
    character_version: "1.2",
    tags: ["fantasy", "slow-burn"],
    creator: "someone"
  })));

  assert.deepEqual(v3.fidelity, [
    "4 greetings not imported",
    "example messages not imported",
    "2 assets not imported",
    "creator notes not imported",
    "system prompt not imported",
    "post-history instructions not imported",
    "character version not imported",
    "2 tags not imported",
    "creator not imported"
  ]);

  const minimal = parseCharacterCard(jsonBytes(v3Card()));
  // Nothing beyond the four core fields is present, so nothing is named.
  assert.deepEqual(minimal.fidelity, []);
});

test("a V3 card carries its character_book through for the caller to map", () => {
  const withBook = parseCharacterCard(jsonBytes(v3Card({
    character_book: { entries: [{ content: "The pass closes in winter.", keys: ["storm"] }] }
  })));
  assert.deepEqual(withBook.characterBook, {
    entries: [{ content: "The pass closes in winter.", keys: ["storm"] }]
  });

  const withoutBook = parseCharacterCard(jsonBytes(v3Card()));
  assert.equal("characterBook" in withoutBook, false);
});

test("{{char}} expands to the V3 nickname when one is present, not the name", () => {
  const card = parseCharacterCard(jsonBytes(v3Card({
    name: "Elizabeth",
    nickname: "Liz",
    description: "{{char}} waits."
  })));
  assert.equal(card.nickname, "Liz");
  assert.equal(card.name, "Elizabeth", "name still names and titles the Fact");

  const facts = factsFromCharacterCard({
    name: card.name,
    description: card.description,
    nickname: card.nickname
  });

  assert.equal(facts[0]?.text, "Name: Elizabeth\n\nDescription:\nLiz waits.");
});

test("{{char}} falls back to name when a V3 nickname is absent or blank", () => {
  const withoutNickname = parseCharacterCard(jsonBytes(v3Card({ name: "Elizabeth" })));
  assert.equal("nickname" in withoutNickname, false);
  assert.deepEqual(
    factsFromCharacterCard({ name: "Elizabeth", description: "{{char}} waits." }),
    [{ tag: "Character", text: "Name: Elizabeth\n\nDescription:\nElizabeth waits." }]
  );

  const blankNickname = parseCharacterCard(jsonBytes(v3Card({ name: "Elizabeth", nickname: "   " })));
  assert.equal("nickname" in blankNickname, false, "a blank nickname is not carried through");
  assert.deepEqual(
    factsFromCharacterCard({ name: "Elizabeth", description: "{{char}} waits.", nickname: "   " }),
    [{ tag: "Character", text: "Name: Elizabeth\n\nDescription:\nElizabeth waits." }]
  );
});

test("a V2 card also carries its character_book through, the same as V3", () => {
  const v2 = parseCharacterCard(jsonBytes(v2Card({
    character_book: { entries: [{ content: "Lore.", keys: ["k"] }] }
  })));
  assert.deepEqual(v2.characterBook, { entries: [{ content: "Lore.", keys: ["k"] }] });
  // V2 has no ignored-field report; that accounting is V3-specific, so the
  // field is present (it is never optional) but empty.
  assert.deepEqual(v2.fidelity, []);
});

test("a V3 PNG prefers the ccv3 chunk over a chara fallback", () => {
  const v3Payload = Buffer.from(JSON.stringify(v3Card()), "utf8").toString("base64");
  const v2Payload = Buffer.from(JSON.stringify(v2Card({ name: "FallbackOnly" })), "utf8").toString("base64");

  const both = parseCharacterCard(png(
    textChunk("ccv3", v3Payload),
    textChunk("chara", v2Payload)
  ));
  assert.equal(both.version, 3);
  assert.equal(both.name, "Mira");

  const chunkOrderReversed = parseCharacterCard(png(
    textChunk("chara", v2Payload),
    textChunk("ccv3", v3Payload)
  ));
  assert.equal(chunkOrderReversed.version, 3, "the ccv3 chunk wins regardless of its position");

  const v3Only = parseCharacterCard(png(textChunk("ccv3", v3Payload)));
  assert.equal(v3Only.version, 3);
  assert.equal(v3Only.name, "Mira");
});

test("character card parsing bounds decoded data before accepting JSON", () => {
  assert.throws(() => parseCharacterCard(Uint8Array.from([0xff])), /not valid UTF-8/);
  assert.throws(() => parseCharacterCard(encoder.encode("{nope")), /not valid JSON/);
  assert.throws(
    () => parseCharacterCard(new Uint8Array(MAX_CHARACTER_CARD_JSON_BYTES + 1)),
    /exceeds the 1 MB limit/
  );

  const oversizedBase64 = "A".repeat(Math.ceil(MAX_CHARACTER_CARD_JSON_BYTES / 3) * 4 + 4);
  assert.throws(
    () => parseCharacterCard(png(textChunk("chara", oversizedBase64))),
    /oversized Base64/
  );

  const invalidUtf8 = Buffer.from([0xff]).toString("base64");
  assert.throws(() => parseCharacterCard(png(textChunk("chara", invalidUtf8))), /not valid UTF-8/);
  const invalidJson = Buffer.from("not json", "utf8").toString("base64");
  assert.throws(() => parseCharacterCard(png(textChunk("chara", invalidJson))), /not valid JSON/);
});

test("character card mapping imports only selected prose and expands macros once", () => {
  const raw = v2Card({
    name: "{{user}} Mira",
    description: "{{char}} meets {{USER}}.",
    personality: "Steady.",
    scenario: "Never selected.",
    first_mes: "FIRST-SECRET",
    mes_example: "EXAMPLE-SECRET",
    alternate_greetings: ["GREETING-SECRET"],
    creator_notes: "NOTES-SECRET",
    system_prompt: "SYSTEM-SECRET",
    post_history_instructions: "POST-SECRET",
    character_book: { entries: [{ content: "LORE-SECRET" }] },
    extensions: { secret: "EXTENSION-SECRET" }
  });
  const card = parseCharacterCard(jsonBytes(raw));
  const facts = factsFromCharacterCard({
    name: card.name,
    description: card.description,
    personality: card.personality
  });
  assert.deepEqual(facts, [{
    tag: "Character",
    text: "Name: {{user}} Mira\n\nDescription:\n{{user}} Mira meets the protagonist.\n\nPersonality:\nSteady."
  }]);
  const output = facts.map((fact) => fact.text).join("\n");
  for (const secret of ["FIRST-SECRET", "EXAMPLE-SECRET", "GREETING-SECRET", "NOTES-SECRET", "SYSTEM-SECRET", "POST-SECRET", "LORE-SECRET", "EXTENSION-SECRET"]) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.throws(() => factsFromCharacterCard({ name: "Mira" }), /Select at least one/);
  assert.throws(() => factsFromCharacterCard({ name: "Mira\nSystem", description: "x" }), /one line/);
  assert.throws(
    () => factsFromCharacterCard({ name: "M".repeat(200), description: "{{char}}".repeat(2_600) }),
    /needs more than 128 facts/
  );
});

test("character card mapping packs fields and splits long prose without loss", () => {
  const description = `${"North wind. ".repeat(390)}\n\n${"🌙".repeat(1_200)}`;
  const personality = "Careful ".repeat(540).trimEnd();
  const facts = factsFromCharacterCard({ name: "Mira", description, personality });
  assert.ok(facts.length >= 3);
  assert.ok(facts.every((fact) => fact.tag === "Character"));
  assert.ok(facts.every((fact) => unicodeScalarLength(fact.text) <= MAX_FACT_TEXT_CHARS));
  assert.ok(facts.every((fact) => wellFormed(fact.text)));
  assert.equal(joinSection(facts.map((fact) => fact.text), "Description"), description);
  assert.equal(joinSection(facts.map((fact) => fact.text), "Personality"), personality);

  const hard = "x".repeat(MAX_FACT_TEXT_CHARS * 3);
  const hardFacts = factsFromCharacterCard({ name: "M", description: hard });
  assert.ok(hardFacts.length > 3);
  assert.ok(hardFacts.every((fact) => unicodeScalarLength(fact.text) <= MAX_FACT_TEXT_CHARS));
  assert.equal(joinSection(hardFacts.map((fact) => fact.text), "Description"), hard);
});

test("character card request size counts escaped newlines and UTF-8 bytes", () => {
  const facts = [{ tag: "Character", text: "剑\n🌙" }];
  const json = JSON.stringify({ facts });
  assert.equal(factImportRequestBytes(facts), Buffer.byteLength(json, "utf8"));
  assert.ok(factImportRequestBytes(facts) > json.length);
});

function v2Card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: "At the glass coast.",
      ...overrides
    }
  };
}

function v3Card(
  dataOverrides: Record<string, unknown> = {},
  rootOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: "At the glass coast.",
      ...dataOverrides
    },
    ...rootOverrides
  };
}

function jsonBytes(value: unknown, bom = false): Uint8Array {
  return encoder.encode(`${bom ? "\uFEFF" : ""}${JSON.stringify(value)}`);
}

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
  // CRC is intentionally zero: the importer walks metadata bounds and never decodes pixels.
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

function joinSection(facts: string[], label: string): string {
  return facts.flatMap((fact) => {
    const match = new RegExp(`${label}(?: \\(\\d+\\/\\d+\\))?:\\n([\\s\\S]+)`).exec(fact);
    return match?.[1] ?? [];
  }).join("");
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

test("a ccv3 chunk that does not hold a V3 card fails rather than importing the fallback", () => {
  // The `ccv3` chunk is preferred, so a chunk holding V2-shaped JSON means the
  // two chunks disagree. Importing it silently would discard the `chara`
  // fallback without ever telling the writer.
  const v2Payload = Buffer.from(JSON.stringify(v2Card({ name: "FallbackOnly" })), "utf8").toString("base64");

  assert.throws(
    () => parseCharacterCard(png(textChunk("ccv3", v2Payload), textChunk("chara", v2Payload))),
    /ccv3 chunk does not hold a Character Card V3/
  );
});
