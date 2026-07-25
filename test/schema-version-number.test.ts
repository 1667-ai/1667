import assert from "node:assert/strict";
import test from "node:test";
import { SchemaVersionNumberScanner } from "../server/schema-version-number.js";

test("schema version number scanner matches JSON Number semantics with bounded state", () => {
  const cases = [
    "2", "3", "4", "2.0", "0.2e1", "20e-1", "400e-2",
    `4.${"0".repeat(100)}`,
    `4.${"0".repeat(100)}1`,
    `0.${"0".repeat(100)}4e101`,
    `4e${"0".repeat(100)}`,
    "1.9999999999999999",
    "1.9999999999999998",
    "1.99999999999999988897769753748434595763683319091796875",
    "1.99999999999999988897769753748434595763683319091796874",
    "2.0000000000000002220446049250313080847263336181640625",
    "2.00000000000000022204460492503130808472633361816406251",
    "2.9999999999999997779553950749686919152736663818359375",
    "2.9999999999999997779553950749686919152736663818359374",
    "3.0000000000000002220446049250313080847263336181640625",
    "3.00000000000000022204460492503130808472633361816406251",
    "4.000000000000000444089209850062616169452667236328125",
    "4.0000000000000004440892098500626161694526672363281251",
    "3.9999999999999997779553950749686919152736663818359375",
    "3.9999999999999997779553950749686919152736663818359374",
    "04", "4.", ".4", "+4", "4e", "4e+", "NaN", "true", "1", "5"
  ];

  for (const raw of cases) {
    const scanner = new SchemaVersionNumberScanner();
    for (const byte of Buffer.from(raw)) scanner.push(byte);
    assert.equal(scanner.finish(), parsedSupportedVersion(raw), raw);
  }
});

function parsedSupportedVersion(raw: string): 2 | 3 | 4 | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value === 2 || value === 3 || value === 4 ? value : null;
  } catch {
    return null;
  }
}
