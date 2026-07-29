import path from "node:path";
import {
  decodeHttpInstanceMetadataResponse,
  encodeHttpAuthRecord,
  type HttpAuthRecord
} from "../../shared/http-auth.js";
import {
  IncompatibleHttpApiError,
  InvalidHttpApiMetadataError,
  preflightHttpApi,
  type HttpCompatibilityAuthority
} from "../../shared/http-compatibility.js";
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
import {
  HttpListenerAuthority,
  type HttpListenerBinding,
  type HttpListenerReplacementOutcome
} from "../../shared/http-listener-authority.js";

export interface HttpAttach {
  readonly origin: string;
  readonly authority: HttpListenerAuthority;
  readonly authRecord: HttpAuthRecord;
  readonly mutationIntents: HttpMutationIntentStore;
  readonly shutdownSignal: AbortSignal;
  confirmListenerReplacement(
    previousInstanceId: string
  ): Promise<HttpListenerReplacementOutcome>;
  dispose(): void;
}

export interface HttpAttachOptions {
  readonly authFile?: string | null;
  readonly stateRoot?: string;
}

export async function attachHttpServer(
  originInput: string,
  options: HttpAttachOptions = {}
): Promise<HttpAttach> {
  const origin = parseCanonicalLoopbackOrigin(originInput).origin;
  const expected = await resolveHttpAuthRecordPaths(origin, {
    ...(options.stateRoot === undefined
      ? {}
      : { stateRoot: options.stateRoot })
  });
  const authFile = options.authFile;
  if (authFile !== null && authFile !== undefined && authFile !== expected.final) {
    throw new Error(
      `--auth-file must be the canonical record for ${origin}: ${expected.final}`
    );
  }
  const authStore = options.stateRoot === undefined
    ? {}
    : { stateRoot: options.stateRoot };
  const { record } = await readHttpAuthRecord(origin, authStore);
  const initialFetch = createDirectLoopbackFetch(origin, record);
  const response = await initialFetch(`${origin}/.well-known/1667-instance`, {
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
  const apiMetadata = await preflightHttpApi(
    `${origin}/api/health`,
    undefined,
    initialFetch,
    compatibilityAuthority(record)
  );
  if (apiMetadata.serverInstanceId !== record.instanceId) {
    throw new Error("1667 health metadata does not match the listening instance");
  }
  const dataDirectoryId = apiMetadata.dataDirectoryId;
  const dataDirectoryClaimId = apiMetadata.dataDirectoryClaimId;
  const mutationIntents = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId,
    dataDirectoryClaimId,
    origin,
    privateStateRoot: path.dirname(expected.directory)
  });
  const refreshLatestListener = async (
    previousInstanceId: string,
    shutdownSignal: AbortSignal
  ): Promise<HttpListenerReplacementOutcome> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (shutdownSignal.aborted) return { kind: "unchanged" };
      let candidate: HttpAuthRecord;
      try {
        ({ record: candidate } = await readHttpAuthRecord(origin, authStore));
      } catch {
        return { kind: "unchanged" };
      }
      if (candidate.instanceId === previousInstanceId) {
        return { kind: "unchanged" };
      }
      const outcome = await inspectListenerCandidate({
        origin,
        candidate,
        shutdownSignal,
        dataDirectoryId,
        dataDirectoryClaimId
      });
      let published: HttpAuthRecord;
      try {
        ({ record: published } = await readHttpAuthRecord(origin, authStore));
      } catch {
        return { kind: "unchanged" };
      }
      if (!sameHttpAuthRecord(candidate, published)) continue;
      if (shutdownSignal.aborted) return { kind: "unchanged" };
      return outcome;
    }
    return { kind: "unchanged" };
  };
  const authority = new HttpListenerAuthority({
    root: origin,
    binding: { authRecord: record, fetch: initialFetch },
    confirmReplacement: refreshLatestListener
  });
  return {
    origin,
    authority,
    get authRecord() {
      return authority.snapshot().authRecord;
    },
    mutationIntents,
    shutdownSignal: authority.shutdownSignal,
    confirmListenerReplacement: authority.confirmListenerReplacement,
    dispose: () => authority.dispose()
  };
}

async function inspectListenerCandidate(input: {
  readonly origin: string;
  readonly candidate: HttpAuthRecord;
  readonly shutdownSignal: AbortSignal;
  readonly dataDirectoryId: string;
  readonly dataDirectoryClaimId: string;
}): Promise<HttpListenerReplacementOutcome> {
  const candidateFetch = createDirectLoopbackFetch(
    input.origin,
    input.candidate
  );
  let response: Response;
  try {
    response = await candidateFetch(
      `${input.origin}/.well-known/1667-instance`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([
          input.shutdownSignal,
          AbortSignal.timeout(5_000)
        ])
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "unchanged" };
    }
    const metadata = await decodeHttpInstanceMetadataResponse(response);
    if (metadata.origin !== input.origin
      || metadata.instanceId !== input.candidate.instanceId
      || input.shutdownSignal.aborted) {
      return { kind: "unchanged" };
    }
  } catch {
    return { kind: "unchanged" };
  }
  let apiMetadata;
  try {
    apiMetadata = await preflightHttpApi(
      `${input.origin}/api/health`,
      input.shutdownSignal,
      candidateFetch,
      compatibilityAuthority(input.candidate)
    );
  } catch (error) {
    return error instanceof IncompatibleHttpApiError
      || error instanceof InvalidHttpApiMetadataError
      ? { kind: "replaced" }
      : { kind: "unchanged" };
  }
  if (input.shutdownSignal.aborted) return { kind: "unchanged" };
  if (apiMetadata.serverInstanceId !== input.candidate.instanceId
    || apiMetadata.dataDirectoryId !== input.dataDirectoryId
    || apiMetadata.dataDirectoryClaimId !== input.dataDirectoryClaimId) {
    return { kind: "replaced" };
  }
  return reboundOutcome(input.candidate, candidateFetch);
}

function sameHttpAuthRecord(
  left: HttpAuthRecord,
  right: HttpAuthRecord
): boolean {
  return encodeHttpAuthRecord(left) === encodeHttpAuthRecord(right);
}

function reboundOutcome(
  authRecord: HttpAuthRecord,
  fetch: HttpFetch
): Extract<HttpListenerReplacementOutcome, { readonly kind: "rebound" }> {
  return {
    kind: "rebound",
    binding: { authRecord, fetch }
  };
}

function compatibilityAuthority(
  record: HttpAuthRecord
): HttpCompatibilityAuthority {
  return {
    capability: record.capabilities.story,
    serverInstanceId: record.instanceId
  };
}
