import { isWorkerMethod, type WorkerMethod } from "./worker-protocol.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION,
  AI_1667_PRODUCT,
  AI_1667_PRODUCT_VERSION,
  type BuildIdentity
} from "./build-identity.js";

export const HTTP_CLIENT_PROTOCOL_HEADER = "x-1667-client-protocol";
export const HTTP_SERVER_INSTANCE_HEADER = "x-1667-server-instance";

export {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_MAX_CLIENT_PROTOCOL_VERSION,
  HTTP_MIN_CLIENT_PROTOCOL_VERSION,
  AI_1667_PRODUCT,
  AI_1667_PRODUCT_VERSION
};

export interface HttpApiMetadata {
  buildIdentity: BuildIdentity;
  serverInstanceId: string;
  recoveryWarnings: HttpRecoveryWarning[];
}

export interface HttpRecoveryWarning {
  mutationId: string;
  method: WorkerMethod;
  storyId: string | null;
  code: string;
  message: string;
  status: number | null;
}

export function isHttpRecoveryWarning(
  value: unknown
): value is HttpRecoveryWarning {
  if (value === null || typeof value !== "object") return false;
  const warning = value as Partial<HttpRecoveryWarning>;
  return typeof warning.mutationId === "string"
    && isWorkerMethod(warning.method)
    && (warning.storyId === null || typeof warning.storyId === "string")
    && typeof warning.code === "string"
    && typeof warning.message === "string"
    && (warning.status === null || Number.isSafeInteger(warning.status));
}

export function attachmentFilename(disposition: string | null, fallback: string): string {
  const match = /(?:^|;)\s*filename="([^"\\/]+)"(?:;|$)/i.exec(disposition ?? "");
  return match?.[1] || fallback;
}
