import path from "node:path";
import {
  decodeHttpInstanceMetadataResponse,
  type HttpAuthRecord
} from "../../shared/http-auth.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import {
  readHttpAuthRecord,
  resolveHttpAuthRecordPaths
} from "../../server/http-auth-record.js";
import {
  createDirectLoopbackFetch,
  type HttpFetch
} from "./direct-loopback-http.js";
import {
  PrivateHttpMutationIntentStore,
  type HttpMutationIntentStore
} from "./http-mutation-intents.js";

export interface HttpAttach {
  readonly origin: string;
  readonly authRecord: HttpAuthRecord;
  readonly fetch: HttpFetch;
  readonly mutationIntents: HttpMutationIntentStore;
  readonly shutdownSignal: AbortSignal;
  confirmListenerReplacement(previousInstanceId: string): Promise<boolean>;
  dispose(): void;
}

export async function attachHttpServer(
  originInput: string,
  authFile?: string | null,
  platform: NodeJS.Platform = process.platform
): Promise<HttpAttach> {
  if (platform === "win32") {
    throw new Error(
      "HTTP attach is unavailable on Windows until a DACL and "
        + "reparse-safe private state adapter is installed."
    );
  }
  const origin = parseCanonicalLoopbackOrigin(originInput).origin;
  const expected = await resolveHttpAuthRecordPaths(origin);
  if (authFile !== null && authFile !== undefined && authFile !== expected.final) {
    throw new Error(
      `--auth-file must be the canonical record for ${origin}: ${expected.final}`
    );
  }
  const { record } = await readHttpAuthRecord(origin);
  const mutationIntents = await PrivateHttpMutationIntentStore.create(
    origin,
    path.dirname(expected.directory)
  );
  let currentRecord = record;
  let currentFetch = createDirectLoopbackFetch(origin, currentRecord);
  const dynamicFetch: HttpFetch = async (input, init) =>
    await currentFetch(input, init);
  const response = await currentFetch(`${origin}/.well-known/1667-instance`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    throw new Error("1667 instance discovery failed");
  }
  const instance = await decodeHttpInstanceMetadataResponse(response);
  if (instance.origin !== origin
    || instance.instanceId !== record.instanceId
    || record.origin !== origin) {
    throw new Error("1667 auth record does not match the listening instance");
  }
  const shutdown = new AbortController();
  return {
    origin,
    get authRecord() {
      return currentRecord;
    },
    fetch: dynamicFetch,
    mutationIntents,
    shutdownSignal: shutdown.signal,
    confirmListenerReplacement: async (previousInstanceId) => {
      if (shutdown.signal.aborted) return false;
      const { record: candidate } = await readHttpAuthRecord(origin);
      if (candidate.instanceId === previousInstanceId) return false;
      const candidateFetch = createDirectLoopbackFetch(origin, candidate);
      const candidateResponse = await candidateFetch(
        `${origin}/.well-known/1667-instance`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(5_000)
          ])
        }
      );
      if (!candidateResponse.ok) return false;
      const metadata = await decodeHttpInstanceMetadataResponse(
        candidateResponse
      );
      if (metadata.origin !== origin
        || metadata.instanceId !== candidate.instanceId
        || shutdown.signal.aborted) {
        return false;
      }
      currentRecord = candidate;
      currentFetch = candidateFetch;
      return true;
    },
    dispose: () => shutdown.abort(
      new DOMException("1667 HTTP client shut down", "AbortError")
    )
  };
}
