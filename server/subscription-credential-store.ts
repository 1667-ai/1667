import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential
} from "@earendil-works/pi-ai";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  modifySubscriptionProviderSecret,
  readSubscriptionProviderSecrets,
  SUBSCRIPTION_SECRET_IDS
} from "./provider-secret-store.js";
import { validateProviderSecretValue } from "../shared/provider-secret-value.js";
import {
  SUBSCRIPTION_PROTOCOLS,
  type SubscriptionProtocol
} from "./subscription-protocol.js";

export type SubscriptionProviderId = "openai-codex" | "anthropic";

export const SUBSCRIPTION_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "anthropic"
] as const satisfies readonly SubscriptionProviderId[]);

/** Reserved machine-tier IDs. They are not valid settings credential IDs. */
export { SUBSCRIPTION_SECRET_IDS };

const ENVELOPE_FORMAT = "1667-subscription-credential";
const ENVELOPE_VERSION = 1;
const MAX_ENVELOPE_BYTES = 16 * 1024;

/** Safe status discriminator for one malformed subscription envelope. */
export class SubscriptionCredentialInvalidError extends Error {
  readonly code = "invalid_subscription_credential" as const;

  constructor() {
    super("Subscription credential operation failed");
    this.name = "SubscriptionCredentialInvalidError";
  }
}

interface SubscriptionCredentialEnvelope {
  readonly format: typeof ENVELOPE_FORMAT;
  readonly version: typeof ENVELOPE_VERSION;
  readonly provider: SubscriptionProviderId;
  readonly credential: {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
    readonly accountId?: string;
  };
}

/** Create the Pi credential store for one machine-tier secrets directory. */
export function createSubscriptionCredentialStore(
  secretsDir: string
): CredentialStore {
  return new FileSubscriptionCredentialStore(secretsDir);
}

/** Read-only mapping used by adapter tests and status surfaces. */
export function subscriptionSecretId(providerId: string): string | undefined {
  return isSubscriptionProviderId(providerId)
    ? SUBSCRIPTION_SECRET_IDS[providerId]
    : undefined;
}

export function subscriptionProviderForProtocolId(
  protocol: SubscriptionProtocol
): SubscriptionProviderId {
  return protocol === SUBSCRIPTION_PROTOCOLS.chatgpt
    ? "openai-codex"
    : "anthropic";
}

class FileSubscriptionCredentialStore implements CredentialStore {
  constructor(private readonly secretsDir: string) {}

  async read(
    providerId: string,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    checkAbort(options?.signal);
    const secretId = requireSubscriptionSecretId(providerId);
    try {
      const secrets = await readSubscriptionProviderSecrets(this.secretsDir);
      checkAbort(options?.signal);
      return decodeCredential(secrets.get(secretId), providerId);
    } catch (error) {
      throw publicCredentialError(error);
    }
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    checkAbort(options?.signal);
    try {
      const secrets = await readSubscriptionProviderSecrets(this.secretsDir);
      const result: CredentialInfo[] = [];
      for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
        checkAbort(options?.signal);
        const credential = decodeCredential(
          secrets.get(SUBSCRIPTION_SECRET_IDS[providerId]),
          providerId
        );
        if (credential !== undefined) {
          result.push({ providerId, type: credential.type });
        }
      }
      return result;
    } catch (error) {
      throw publicCredentialError(error);
    }
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    checkAbort(options?.signal);
    const secretId = requireSubscriptionSecretId(providerId);
    try {
      const raw = await modifySubscriptionProviderSecret(this.secretsDir, secretId, async (raw) => {
        checkAbort(options?.signal);
        const current = decodeCredentialForModify(raw, providerId);
        let next: Credential | undefined;
        try {
          next = await fn(current);
        } catch (error) {
          checkAbort(options?.signal);
          throw publicCredentialError(error);
        }
        // Pi uses undefined to mean "leave the entry unchanged". The
        // provider-secret primitive has the same meaning for its callback.
        // Once the callback resolves, the returned credential must reach the
        // provider-secret commit boundary before cancellation propagates.
        if (next === undefined) {
          return undefined;
        }
        const encoded = encodeCredential(providerId, next);
        return encoded;
      }, { signal: options?.signal });
      checkAbort(options?.signal);
      return decodeCredential(raw, providerId);
    } catch (error) {
      throw publicCredentialError(error);
    }
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions
  ): Promise<void> {
    checkAbort(options?.signal);
    const secretId = requireSubscriptionSecretId(providerId);
    try {
      await modifySubscriptionProviderSecret(
        this.secretsDir,
        secretId,
        () => null,
        { signal: options?.signal }
      );
      checkAbort(options?.signal);
    } catch (error) {
      throw publicCredentialError(error);
    }
  }
}

function decodeCredentialForModify(
  raw: string | undefined,
  providerId: string
): Credential | undefined {
  try {
    return decodeCredential(raw, providerId);
  } catch (error) {
    if (error instanceof SubscriptionCredentialInvalidError) return undefined;
    throw error;
  }
}

function decodeCredential(
  raw: string | undefined,
  providerId: string
): Credential | undefined {
  if (raw === undefined) return undefined;
  const provider = requireSubscriptionProviderId(providerId);
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new SubscriptionCredentialInvalidError();
  }
  try {
    validateProviderSecretValue(raw);
  } catch {
    throw new SubscriptionCredentialInvalidError();
  }
  let value: unknown;
  try {
    value = parseJsonRejectingDuplicateKeys(raw, "subscription credential");
  } catch {
    throw new SubscriptionCredentialInvalidError();
  }
  try {
    const envelope = requireEnvelope(value, provider);
    const credential = envelope.credential;
    const result: OAuthCredential = {
      type: "oauth",
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId })
    };
    return result;
  } catch {
    throw new SubscriptionCredentialInvalidError();
  }
}

function encodeCredential(
  providerId: string,
  credential: Credential
): string {
  const provider = requireSubscriptionProviderId(providerId);
  try {
    if (credential.type !== "oauth") throw new Error("credential type");
    const access = validateProviderSecretValue(credential.access);
    const refresh = validateProviderSecretValue(credential.refresh);
    if (!Number.isFinite(credential.expires)) throw new Error("expiry");
    const accountId = credential.accountId;
    if (accountId !== undefined) {
      if (provider !== "openai-codex" || typeof accountId !== "string" || accountId.length === 0) {
        throw new Error("metadata");
      }
    }
    const envelope: SubscriptionCredentialEnvelope = {
      format: ENVELOPE_FORMAT,
      version: ENVELOPE_VERSION,
      provider,
      credential: {
        type: "oauth",
        access,
        refresh,
        expires: credential.expires,
        ...(accountId === undefined ? {} : { accountId })
      }
    };
    const raw = JSON.stringify(envelope);
    if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new Error("Subscription credential is too large");
    }
    return raw;
  } catch {
    throw new Error("Subscription credential is invalid");
  }
}

function requireEnvelope(
  value: unknown,
  provider: SubscriptionProviderId
): SubscriptionCredentialEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("envelope");
  }
  const record = value as Record<string, unknown>;
  requireExactKeys(record, ["format", "version", "provider", "credential"]);
  if (record.format !== ENVELOPE_FORMAT
    || record.version !== ENVELOPE_VERSION
    || record.provider !== provider) {
    throw new Error("envelope identity");
  }
  if (
    record.credential === null
    || typeof record.credential !== "object"
    || Array.isArray(record.credential)
  ) throw new Error("credential");
  const credential = record.credential as Record<string, unknown>;
  const allowed = provider === "openai-codex"
    ? ["type", "access", "refresh", "expires", "accountId"]
    : ["type", "access", "refresh", "expires"];
  requireExactKeys(credential, allowed, ["type", "access", "refresh", "expires"]);
  if (credential.type !== "oauth") throw new Error("credential type");
  const access = validateProviderSecretValue(credential.access);
  const refresh = validateProviderSecretValue(credential.refresh);
  if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
    throw new Error("credential expiry");
  }
  if (provider === "openai-codex" && credential.accountId !== undefined
    && (typeof credential.accountId !== "string" || credential.accountId.length === 0)) {
    throw new Error("credential metadata");
  }
  const accountId = credential.accountId === undefined
    ? undefined
    : credential.accountId as string;
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    provider,
    credential: {
      type: "oauth",
      access,
      refresh,
      expires: credential.expires,
      ...(accountId === undefined ? {} : { accountId })
    }
  };
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  requiredKeys: readonly string[] = keys
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("unknown field");
  if (requiredKeys.some((key) => !Object.hasOwn(record, key))) throw new Error("missing field");
}

function requireSubscriptionSecretId(providerId: string): string {
  const provider = requireSubscriptionProviderId(providerId);
  return SUBSCRIPTION_SECRET_IDS[provider];
}

function requireSubscriptionProviderId(providerId: string): SubscriptionProviderId {
  if (!isSubscriptionProviderId(providerId)) {
    throw new Error("Unsupported subscription provider");
  }
  return providerId;
}

function isSubscriptionProviderId(value: string): value is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Subscription credential operation cancelled");
}

function publicCredentialError(error: unknown): Error {
  if (error instanceof SubscriptionCredentialInvalidError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof Error && error.message === "Subscription credential operation cancelled") return error;
  // Do not carry OAuth response bodies, access tokens, or refresh tokens over
  // the Pi boundary. The private error reporter has no need for them either.
  return new Error("Subscription credential operation failed");
}
