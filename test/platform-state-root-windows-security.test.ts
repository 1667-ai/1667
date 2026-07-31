import assert from "node:assert/strict";
import test from "node:test";
import type { BunFfi, FfiLibrary } from "../server/bun-ffi.js";
import {
  privateAcl,
  type WindowsSecurityLibraries
} from "../server/platform-state-root-windows-bun-security.js";

test("Windows private DACL collapses identical user and SYSTEM principals", () => {
  const added: number[] = [];
  const libraries = securityLibraries(added);
  const ffi = fakeFfi();

  const systemAcl = privateAcl(
    ffi,
    libraries,
    { user: 7, system: 7 },
    "directory"
  );
  assert.deepEqual(added, [7]);
  assert.equal(systemAcl.byteLength, 28);

  added.length = 0;
  const userAcl = privateAcl(
    ffi,
    libraries,
    { user: 7, system: 9 },
    "directory"
  );
  assert.deepEqual(added, [7, 9]);
  assert.equal(userAcl.byteLength, 48);
});

function fakeFfi(): BunFfi {
  return {
    dlopen: () => { throw new Error("unexpected dlopen"); },
    ptr: () => 1,
    toArrayBuffer: () => new ArrayBuffer(0)
  };
}

function securityLibraries(added: number[]): WindowsSecurityLibraries {
  const library = (symbols: FfiLibrary["symbols"]): FfiLibrary => ({
    symbols,
    close: () => {}
  });
  return {
    kernel: library({ GetLastError: () => 0 }),
    advapi: library({
      EqualSid: (left, right) => Number(left === right),
      GetLengthSid: () => 12,
      InitializeAcl: () => 1,
      AddAccessAllowedAceEx: (...args) => {
        added.push(Number(args[4]));
        return 1;
      }
    })
  };
}
