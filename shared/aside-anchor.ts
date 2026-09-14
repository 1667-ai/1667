import { AsideDocumentError } from "./aside-core.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";

/** The immutable story position that owns one Aside session. */
export interface AsideAnchor {
  readonly partId: string;
  readonly takeId: string;
}

/** Validate an immutable session anchor in browser-safe shared code. */
export function assertAsideAnchor(anchor: AsideAnchor | null): void {
  if (anchor === null) return;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new AsideDocumentError("Aside session anchor must be an object or null");
  }
  const keys = Object.keys(anchor);
  if (keys.length !== 2 || !keys.includes("partId") || !keys.includes("takeId")) {
    throw new AsideDocumentError("Aside session anchor has unknown or missing keys");
  }
  assertAsideIdentifier(anchor.partId, "partId");
  assertAsideIdentifier(anchor.takeId, "takeId");
}

function assertAsideIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AsideDocumentError(`Aside session ${label} must be a non-empty string`);
  }
  if (hasUnpairedSurrogate(value)) {
    throw new AsideDocumentError(`Aside session ${label} contains an unpaired Unicode surrogate`);
  }
  if (value.normalize("NFC") !== value) {
    throw new AsideDocumentError(`Aside session ${label} must be NFC-normalized`);
  }
  if (unicodeScalarLength(value, 1_024 + 1) > 1_024) {
    throw new AsideDocumentError(`Aside session ${label} exceeds 1,024 Unicode scalars`);
  }
}
