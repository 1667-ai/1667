import { ServiceError } from "./errors.js";
import { MAX_TOTAL_CHARS } from "./import-st.js";

export const MAX_NOVELAI_RECORDS = 50_000;
const MAX_DECODE_TOKENS = MAX_NOVELAI_RECORDS * 10;
const MAX_DECODE_DEPTH = 128;
const MAX_SCALAR_BYTES = MAX_TOTAL_CHARS * 4;

// These extensions decode the value that follows their tag. Counting that
// value as a child keeps extension chains inside the same depth budget.
const FOLLOWED_BY_VALUE_EXTENSIONS = new Set([
  20, 30, 31, 40, 41, 42,
  0x62, 0x65, 0x69, 0x72, 0x73, 0x78
]);

/** Bound attacker-controlled MessagePack before msgpackr materializes it. */
export function assertBoundedNovelAiMessagePack(bytes: Uint8Array): void {
  let offset = 0;
  let tokens = 0;
  const pendingChildren: number[] = [];

  const requireBytes = (length: number): void => {
    if (!Number.isSafeInteger(length)
      || length < 0
      || length > bytes.length - offset) {
      throw malformedMessagePack();
    }
  };
  const readByte = (): number => {
    requireBytes(1);
    return bytes[offset++]!;
  };
  const readUint16 = (): number => {
    requireBytes(2);
    const value = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    offset += 2;
    return value;
  };
  const readUint32 = (): number => {
    requireBytes(4);
    const value = bytes[offset]! * 0x1000000
      + bytes[offset + 1]! * 0x10000
      + bytes[offset + 2]! * 0x100
      + bytes[offset + 3]!;
    offset += 4;
    return value;
  };
  const skip = (length: number, scalar = false): void => {
    if (scalar && length > MAX_SCALAR_BYTES) {
      throw new ServiceError(400, "MessagePack scalar exceeds the import budget");
    }
    requireBytes(length);
    offset += length;
  };
  const containerChildren = (items: number, map: boolean): number => {
    if (items > MAX_NOVELAI_RECORDS) {
      throw new ServiceError(
        400,
        `MessagePack container has more than ${MAX_NOVELAI_RECORDS} items`
      );
    }
    return map ? items * 2 : items;
  };
  const extension = (length: number): number => {
    const type = readByte();
    skip(length, true);
    return FOLLOWED_BY_VALUE_EXTENSIONS.has(type) ? 1 : 0;
  };

  while (offset < bytes.length) {
    while (pendingChildren.at(-1) === 0) pendingChildren.pop();
    if (pendingChildren.length > 0) {
      pendingChildren[pendingChildren.length - 1]! -= 1;
    }
    tokens += 1;
    if (tokens > MAX_DECODE_TOKENS) {
      throw new ServiceError(400, "MessagePack document has too many values");
    }

    const marker = readByte();
    let children = 0;
    if (marker <= 0x7f || marker >= 0xe0) {
      // Positive and negative fixed integers.
    } else if (marker <= 0x8f) {
      children = containerChildren(marker & 0x0f, true);
    } else if (marker <= 0x9f) {
      children = containerChildren(marker & 0x0f, false);
    } else if (marker <= 0xbf) {
      skip(marker & 0x1f, true);
    } else {
      switch (marker) {
        case 0xc0:
        case 0xc2:
        case 0xc3:
          break;
        case 0xc1:
          children = 1;
          break;
        case 0xc4:
          skip(readByte(), true);
          break;
        case 0xc5:
          skip(readUint16(), true);
          break;
        case 0xc6:
          skip(readUint32(), true);
          break;
        case 0xc7:
          children = extension(readByte());
          break;
        case 0xc8:
          children = extension(readUint16());
          break;
        case 0xc9:
          children = extension(readUint32());
          break;
        case 0xca:
          skip(4);
          break;
        case 0xcb:
          skip(8);
          break;
        case 0xcc:
        case 0xd0:
          skip(1);
          break;
        case 0xcd:
        case 0xd1:
          skip(2);
          break;
        case 0xce:
        case 0xd2:
          skip(4);
          break;
        case 0xcf:
        case 0xd3:
          skip(8);
          break;
        case 0xd4:
          children = extension(1);
          break;
        case 0xd5:
          children = extension(2);
          break;
        case 0xd6:
          children = extension(4);
          break;
        case 0xd7:
          children = extension(8);
          break;
        case 0xd8:
          children = extension(16);
          break;
        case 0xd9:
          skip(readByte(), true);
          break;
        case 0xda:
          skip(readUint16(), true);
          break;
        case 0xdb:
          skip(readUint32(), true);
          break;
        case 0xdc:
          children = containerChildren(readUint16(), false);
          break;
        case 0xdd:
          children = containerChildren(readUint32(), false);
          break;
        case 0xde:
          children = containerChildren(readUint16(), true);
          break;
        case 0xdf:
          children = containerChildren(readUint32(), true);
          break;
        default:
          throw malformedMessagePack();
      }
    }

    if (children > 0) {
      if (pendingChildren.length >= MAX_DECODE_DEPTH) {
        throw new ServiceError(400, "MessagePack document is nested too deeply");
      }
      pendingChildren.push(children);
    }
  }

  while (pendingChildren.at(-1) === 0) pendingChildren.pop();
  if (pendingChildren.length > 0) throw malformedMessagePack();
}

function malformedMessagePack(): ServiceError {
  return new ServiceError(400, "Malformed MessagePack document");
}
