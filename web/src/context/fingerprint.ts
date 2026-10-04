import type { ChatMessage } from "../../../shared/prompt-plan.js";

/** A 53-bit string hash (cyrb53). */
function hash(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Names a rendered prompt and the route it is counted on: the same messages
 * and route always give the same string. The server's own fingerprint needs
 * `node:crypto`; the browser needs only to tell two prompts apart. */
export function promptFingerprint(messages: readonly ChatMessage[], route: string): string {
  let length = 0;
  let h = hash(route, 1);
  for (const message of messages) {
    length += message.content.length;
    h = hash(`${message.role}\u0000${message.content}`, h % 2147483647);
  }
  return `${messages.length}:${length}:${h.toString(36)}`;
}
