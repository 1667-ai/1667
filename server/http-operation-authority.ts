import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type { HttpCapabilityScope } from "../shared/http-auth.js";
import { HTTP_OPERATION_MAX_SEQUENCE } from "../shared/http-operation-protocol.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const TICKET_PATTERN = /^([0-9a-f]{32})\.([1-9][0-9]{0,19})\.([0-9a-f]{64})$/;

/** Stateless MAC authority owned by one listener incarnation. */
export class HttpOperationAuthority {
  private readonly secret: Buffer;

  constructor(
    private readonly listenerInstanceId: string,
    secret: Uint8Array = randomBytes(32)
  ) {
    this.secret = Buffer.from(secret);
    if (this.secret.byteLength !== 32) {
      throw new Error("HTTP operation-session signing secret must be 32 bytes");
    }
  }

  createSessionId(): string {
    return randomBytes(16).toString("hex");
  }

  sessionId(capability: string): string | null {
    return CAPABILITY_PATTERN.test(capability)
      ? capability.slice(0, 32)
      : null;
  }

  matchesSessionCapability(
    capability: string,
    id: string,
    scope: HttpCapabilityScope
  ): boolean {
    return safeHexEqual(capability, this.sessionCapability(id, scope));
  }

  matchesAnySessionScope(capability: string, id: string): boolean {
    return (["story", "admin"] as const).some((scope) =>
      this.matchesSessionCapability(capability, id, scope));
  }

  sessionCapability(id: string, scope: HttpCapabilityScope): string {
    if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid HTTP session ID");
    const tag = createHmac("sha256", this.secret)
      .update(`session-v1\0${this.listenerInstanceId}\0${scope}\0${id}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    return `${id}${tag}`;
  }

  originKey(capability: string): string {
    return createHmac("sha256", this.secret)
      .update(`origin-v1\0${this.listenerInstanceId}\0${capability}`, "utf8")
      .digest("hex");
  }

  operationTicket(
    session: { readonly id: string; readonly scope: HttpCapabilityScope },
    sequence: bigint
  ): string {
    return `${session.id}.${sequence}.${this.ticketMac(session, sequence)}`;
  }

  parseOperationTicket(
    ticket: string,
    session: { readonly id: string; readonly scope: HttpCapabilityScope }
  ): bigint | null {
    const sequence = this.parseOperationTicketSequence(ticket, session.id);
    if (sequence === null) return null;
    const match = TICKET_PATTERN.exec(ticket);
    if (match === null) return null;
    return safeHexEqual(match[3]!, this.ticketMac(session, sequence))
      ? sequence
      : null;
  }

  parseOperationTicketSequence(ticket: string, sessionId: string): bigint | null {
    const match = TICKET_PATTERN.exec(ticket);
    if (match === null || match[1] !== sessionId) return null;
    const sequence = BigInt(match[2]!);
    return sequence >= 1n && sequence <= HTTP_OPERATION_MAX_SEQUENCE
      ? sequence
      : null;
  }

  matchesStoredValue(value: string, expected: string): boolean {
    const left = Buffer.from(value, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private ticketMac(
    session: { readonly id: string; readonly scope: HttpCapabilityScope },
    sequence: bigint
  ): string {
    return createHmac("sha256", this.secret)
      .update(
        `operation-v1\0${this.listenerInstanceId}\0${session.id}\0`
          + `${session.scope}\0${sequence}`,
        "utf8"
      )
      .digest("hex");
  }
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}
