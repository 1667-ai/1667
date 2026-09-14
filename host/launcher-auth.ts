import type {
  Credential,
  CredentialStore,
  MutableModels,
  AuthInteraction
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  createSubscriptionCredentialStore,
  SubscriptionCredentialInvalidError
} from "../server/subscription-credential-store.js";
import { createSubscriptionModels } from "../server/subscription-models.js";
import {
  resolveMachineTierRoot,
  resolveMachineTierRootPath
} from "../server/machine-tier.js";
import { isUsableOAuthCredential } from "../server/subscription-runtime.js";

export type SubscriptionProvider = "chatgpt" | "claude";

export interface AuthModels {
  readonly login: MutableModels["login"];
  readonly logout: MutableModels["logout"];
}

export interface AuthCredentials {
  readonly read: CredentialStore["read"];
}

export interface AuthDependencies {
  readonly models: AuthModels;
  readonly credentials: AuthCredentials;
}

export interface AuthLoginRequest {
  readonly provider: SubscriptionProvider;
  readonly dependencies: AuthDependencies;
  readonly confirm: () => Promise<boolean>;
  readonly interaction: AuthInteraction;
}

export type AuthLoginResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "signed-in" };

export interface AuthStatus {
  readonly provider: SubscriptionProvider;
  readonly label: string;
  readonly status: "signed out" | "signed in" | "signed in (refreshes on next use)";
}

const PROVIDERS: Readonly<Record<SubscriptionProvider, { readonly label: string; readonly piId: string }>> = {
  chatgpt: { label: "ChatGPT", piId: "openai-codex" },
  claude: { label: "Claude", piId: "anthropic" }
};

/** Build the subscription coordinator for the requested machine-tier access. */
export async function createProductionAuthDependencies(
  action: "login" | "status" | "logout"
): Promise<AuthDependencies> {
  const secretsDir = action === "status"
    ? await resolveMachineTierRootPath()
    : await resolveMachineTierRoot();
  registerBunOAuthFlows();
  const credentials = createSubscriptionCredentialStore(secretsDir);
  return {
    credentials,
    models: createSubscriptionModels(credentials)
  };
}

/** Run the provider login after the caller has supplied its interaction. */
export async function loginSubscription(
  request: AuthLoginRequest
): Promise<AuthLoginResult> {
  if (!await request.confirm()) return { kind: "cancelled" };
  const definition = PROVIDERS[request.provider];
  try {
    await request.dependencies.models.login(definition.piId, "oauth", request.interaction);
  } catch (error) {
    if (isPromptCancellation(error)) return { kind: "cancelled" };
    throw new Error(
      `Could not sign in to ${definition.label}. Try again or use an API key connection.`
    );
  }
  return { kind: "signed-in" };
}

/** Read credentials only. This operation never refreshes a provider token. */
export async function readSubscriptionStatus(
  dependencies: AuthDependencies,
  now = Date.now
): Promise<readonly AuthStatus[]> {
  const statuses: AuthStatus[] = [];
  for (const provider of ["chatgpt", "claude"] as const) {
    const definition = PROVIDERS[provider];
    let credential: Credential | undefined;
    try {
      credential = await dependencies.credentials.read(definition.piId);
    } catch (error) {
      if (error instanceof SubscriptionCredentialInvalidError) {
        credential = undefined;
      } else {
        throw new Error(`Could not read ${definition.label} sign-in status.`);
      }
    }
    const status = !isUsableOAuthCredential(credential)
      ? "signed out"
      : credential.expires <= now()
        ? "signed in (refreshes on next use)"
        : "signed in";
    statuses.push({ provider, label: definition.label, status });
  }
  return statuses;
}

/** Remove one local provider credential. */
export async function logoutSubscription(
  provider: SubscriptionProvider,
  dependencies: AuthDependencies
): Promise<void> {
  try {
    await dependencies.models.logout(PROVIDERS[provider].piId);
  } catch {
    throw new Error(`Could not sign out of ${PROVIDERS[provider].label}.`);
  }
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error
    && error.name === "AbortError"
    && (error.message === "Sign-in prompt cancelled"
      || error.message === "Vault Password prompt cancelled"
      || error.message === "Vault Password prompt input ended"
      || error.message === "Vault Password prompt input closed");
}
