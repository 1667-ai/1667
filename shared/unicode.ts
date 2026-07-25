export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function unicodeScalarLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let length = 0;
  for (const _scalar of value) {
    length += 1;
    if (length > stopAfter) break;
  }
  return length;
}

/** Preserve legacy UTF-16 truncation widths without manufacturing an unpaired
 * surrogate when the boundary lands inside a scalar. */
export function sliceWellFormedUtf16Prefix(value: string, maxCodeUnits: number): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
    throw new RangeError("UTF-16 prefix bound must be a non-negative safe integer");
  }
  if (value.length <= maxCodeUnits) return value;
  let end = maxCodeUnits;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return value.slice(0, end);
}
