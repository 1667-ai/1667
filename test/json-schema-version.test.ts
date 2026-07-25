import assert from "node:assert/strict";
import test from "node:test";
import { hasLegacyTopLevelSchemaVersion } from "../server/json-schema-version.js";

test("legacy schema discriminator validates complete JSON structure", () => {
  const valid = [
    '{"padding":{"values":[true,false,null,-1.2e+3,"text"]},"schemaVersion":4}',
    '{"schemaVersion":5,"schemaVersion":2}',
    '{"schemaVersion":6,"\\u0073\\u0063\\u0068\\u0065\\u006d\\u0061\\u0056\\u0065\\u0072\\u0073\\u0069\\u006f\\u006e":4}',
    '{"schemaVersion":4.000000000000000000000000000000000000000000000000000000}',
    '{"nested":{"schemaVersion":6},"schemaVersion":3}',
    '{"escaped":"\\u1234\\n\\\"","schemaVersion":4}',
    `{"padding":${"[".repeat(255)}0${"]".repeat(255)},"schemaVersion":4}`
  ];
  const invalid = [
    '4',
    '[{"schemaVersion":4}]',
    '{"padding":[},"schemaVersion":4}',
    '{"padding":{],"schemaVersion":4}',
    '{"padding":[1,],"schemaVersion":4}',
    '{"padding":{"a":1,},"schemaVersion":4}',
    '{"padding":[,1],"schemaVersion":4}',
    '{"padding":tru,"schemaVersion":4}',
    '{"padding":"\\x","schemaVersion":4}',
    '{"padding":"\\u12x4","schemaVersion":4}',
    '{"padding":"\u0001","schemaVersion":4}',
    '{"padding":01,"schemaVersion":4}',
    '\ufeff{"schemaVersion":4}',
    '{"schemaVersion":4} trailing',
    `{"padding":${"[".repeat(256)}0${"]".repeat(256)},"schemaVersion":4}`,
    '{"schemaVersion":4,"schemaVersion":6}'
  ];

  for (const raw of valid) assert.equal(hasLegacyTopLevelSchemaVersion(Buffer.from(raw)), true, raw);
  for (const raw of invalid) assert.equal(hasLegacyTopLevelSchemaVersion(Buffer.from(raw)), false, raw);
});

test("legacy schema discriminator permits replacement bytes only inside JSON strings", () => {
  const inside = Buffer.from('{"title":"x","schemaVersion":4}');
  inside[inside.indexOf(0x78)] = 0xff;
  assert.equal(hasLegacyTopLevelSchemaVersion(inside), true);

  const outside = Buffer.from('{"padding":0,"schemaVersion":4}');
  outside[outside.indexOf(0x30)] = 0xff;
  assert.equal(hasLegacyTopLevelSchemaVersion(outside), false);
});
