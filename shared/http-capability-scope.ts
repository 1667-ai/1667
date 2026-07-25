import type { HttpCapabilityScope } from "./http-auth.js";
import {
  protectedHttpApiScopeForHead,
  type ProtectedHttpApiHead
} from "./http-operation-policy.js";

export type { ProtectedHttpApiHead } from "./http-operation-policy.js";

export interface ProtectedHttpApiRoute {
  readonly head: ProtectedHttpApiHead;
  readonly scope: HttpCapabilityScope;
}

export function protectedHttpApiRouteForHead(
  apiHead: string
): ProtectedHttpApiRoute | null {
  return protectedHttpApiScopeForHead(apiHead);
}

export function httpCapabilityScopeForApiPath(
  pathname: string
): HttpCapabilityScope {
  if (!pathname.startsWith("/api/")) {
    throw new Error("1667 capability scope requires an API path");
  }
  const apiHead = pathname.slice("/api/".length).split("/", 1)[0]!;
  if (apiHead.length === 0) {
    throw new Error("1667 capability scope requires a nonempty API path");
  }
  const route = protectedHttpApiRouteForHead(apiHead);
  if (route === null) {
    throw new Error(`1667 capability scope has no registered API head: ${apiHead}`);
  }
  return route.scope;
}
