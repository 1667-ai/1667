import { ServiceError } from "./errors.js";
import { MAX_TOTAL_CHARS } from "./import-st.js";

export const MAX_NOVELAI_RECORDS = 50_000;
const MAX_DECODE_TOKENS = MAX_NOVELAI_RECORDS * 10;
const MAX_DECODE_DEPTH = 128;
const MAX_SCALAR_BYTES = MAX_TOTAL_CHARS * 4;

// NovelAI's own extensions decode the value following their tag. Other
// msgpackr semantic extensions stay closed unless explicitly handled below.
const NOVELAI_VALUE_EXTENSIONS = new Set([20, 30, 31, 40, 41, 42]);

interface RecordShape {
  readonly fields: number;
  readonly highByte: number | undefined;
}

function twoByteRecordId(firstId: number, highByte: number): number {
  return firstId < 32
    ? -((highByte << 5) + firstId)
    : (highByte << 5) + firstId;
}

/** Bound attacker-controlled MessagePack before msgpackr materializes it. */
export function assertBoundedNovelAiMessagePack(bytes: Uint8Array): void {
  let offset = 0;
  let tokens = 0;
  let bundledStringBytes = 0;
  const pendingChildren: number[] = [];
  const records = new Map<number, RecordShape>();

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
  const readUint32At = (start: number): number => {
    if (start < 0 || start + 4 > bytes.length) throw malformedMessagePack();
    return bytes[start]! * 0x1000000
      + bytes[start + 1]! * 0x10000
      + bytes[start + 2]! * 0x100
      + bytes[start + 3]!;
  };
  const readUint16At = (start: number): number => {
    if (start < 0 || start + 2 > bytes.length) throw malformedMessagePack();
    return bytes[start]! * 0x100 + bytes[start + 1]!;
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
  const bundledStringAt = (start: number): { end: number; bytes: number } => {
    if (start < 0 || start >= bytes.length) throw malformedMessagePack();
    const marker = bytes[start]!;
    let headerBytes = 1;
    let stringBytes: number;
    if (marker >= 0xa0 && marker <= 0xbf) {
      stringBytes = marker & 0x1f;
    } else if (marker === 0xd9) {
      if (start + 2 > bytes.length) throw malformedMessagePack();
      headerBytes = 2;
      stringBytes = bytes[start + 1]!;
    } else if (marker === 0xda) {
      if (start + 3 > bytes.length) throw malformedMessagePack();
      headerBytes = 3;
      stringBytes = bytes[start + 1]! * 0x100 + bytes[start + 2]!;
    } else if (marker === 0xdb) {
      if (start + 5 > bytes.length) throw malformedMessagePack();
      headerBytes = 5;
      stringBytes = readUint32At(start + 1);
    } else {
      throw malformedMessagePack();
    }
    if (stringBytes > MAX_SCALAR_BYTES
      || stringBytes > bytes.length - start - headerBytes) {
      throw new ServiceError(400, "MessagePack scalar exceeds the import budget");
    }
    return { end: start + headerBytes + stringBytes, bytes: stringBytes };
  };
  const arrayLengthAt = (start: number): number => {
    if (start < 0 || start >= bytes.length) throw malformedMessagePack();
    const marker = bytes[start]!;
    if (marker >= 0x90 && marker <= 0x9f) return marker & 0x0f;
    if (marker === 0xdc) return containerChildren(readUint16At(start + 1), false);
    if (marker === 0xdd) return containerChildren(readUint32At(start + 1), false);
    throw malformedMessagePack();
  };
  const extension = (length: number, canDefineRecord = false): number => {
    const type = readByte();
    const payloadStart = offset;
    skip(length, true);
    if (type === 0x72 && canDefineRecord) {
      if (length !== 1 && length !== 2) throw malformedMessagePack();
      const firstId = bytes[payloadStart]! & 0x3f;
      const highByte = length === 2 ? bytes[payloadStart + 1]! : undefined;
      const id = highByte === undefined
        ? firstId
        : twoByteRecordId(firstId, highByte);
      const fields = arrayLengthAt(offset);
      records.set(id, { fields, highByte });
      return fields + 1;
    }
    if (type === 0x62) {
      if (length < 4) throw malformedMessagePack();
      const bundleDistance = readUint32At(payloadStart);
      const bundleStart = offset + bundleDistance - length;
      if (bundleDistance > 0x7fff_ffff || bundleStart < offset) {
        throw malformedMessagePack();
      }
      const first = bundledStringAt(bundleStart);
      const second = bundledStringAt(first.end);
      bundledStringBytes += first.bytes + second.bytes;
      if (bundledStringBytes > MAX_SCALAR_BYTES) {
        throw new ServiceError(400, "MessagePack bundled strings exceed the import budget");
      }
      return 1;
    }
    if (type === 0x73) {
      // History nodes use Sets. msgpackr encodes them from an array; requiring
      // that form prevents iterable inputs from expanding during Set creation.
      arrayLengthAt(offset);
      return 1;
    }
    if (NOVELAI_VALUE_EXTENSIONS.has(type)) return 1;
    if (type === 0) {
      if (length !== 1) throw malformedMessagePack();
      return 0;
    }
    if (type === 0xff) {
      if (length !== 4 && length !== 8 && length !== 12) {
        throw malformedMessagePack();
      }
      return 0;
    }
    throw new ServiceError(400, "Unsupported MessagePack extension");
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
    if (marker <= 0x3f || marker >= 0xe0) {
      // Positive and negative fixed integers outside msgpackr's record range.
    } else if (marker <= 0x7f) {
      const firstId = marker & 0x3f;
      let record = records.get(firstId);
      if (record?.highByte === 0) {
        const highByte = readByte();
        record = records.get(twoByteRecordId(firstId, highByte));
        if (record === undefined) throw malformedMessagePack();
      }
      children = record?.fields ?? 0;
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
          children = extension(1, true);
          break;
        case 0xd5:
          children = extension(2, true);
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
