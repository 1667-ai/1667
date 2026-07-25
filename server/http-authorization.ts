import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  HttpAuthRecord,
  HttpCapabilityScope
} from "../shared/http-auth.js";
import { ServiceError } from "./errors.js";

const INVALID_CAPABILITY = Buffer.alloc(32);

export function requireHttpCapability(
  request: IncomingMessage,
  required: HttpCapabilityScope,
  record: HttpAuthRecord
): HttpCapabilityScope {
  const authorized = optionalHttpCapabilityScope(request, record);
  if (required === authorized) {
    return required;
  }
  if (authorized !== null) {
    throw new ServiceError(403, `The ${required} capability is required`, "forbidden");
  }
  throw new ServiceError(401, "Missing or invalid 1667 capability", "unauthorized");
}

export function requireAnyHttpCapability(
  request: IncomingMessage,
  record: HttpAuthRecord
): HttpCapabilityScope {
  const authorized = optionalHttpCapabilityScope(request, record);
  if (authorized !== null) return authorized;
  throw new ServiceError(401, "Missing or invalid 1667 capability", "unauthorized");
}

export function optionalHttpCapabilityScope(
  request: IncomingMessage,
  record: HttpAuthRecord
): HttpCapabilityScope | null {
  const candidate = decodeBearer(request.headers.authorization);
  const storyMatch = timingSafeEqual(candidate, Buffer.from(record.capabilities.story, "hex"));
  const adminMatch = timingSafeEqual(candidate, Buffer.from(record.capabilities.admin, "hex"));
  if (storyMatch) return "story";
  if (adminMatch) return "admin";
  return null;
}

export function httpBearerCapability(value: string | undefined): string | null {
  return /^Bearer ([0-9a-f]{64})$/.exec(value ?? "")?.[1] ?? null;
}

function decodeBearer(value: string | undefined): Buffer {
  const capability = httpBearerCapability(value);
  return capability === null
    ? INVALID_CAPABILITY
    : Buffer.from(capability, "hex");
}
