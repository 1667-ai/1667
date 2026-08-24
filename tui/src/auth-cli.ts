import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  MutableModels
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  createSubscriptionCredentialStore,
  SubscriptionCredentialInvalidError
} from "../../server/subscription-credential-store.js";
import { createSubscriptionModels } from "../../server/subscription-models.js";
import {
  resolveMachineTierRoot,
  resolveMachineTierRootPath
} from "../../server/machine-tier.js";
import { isUsableOAuthCredential } from "../../server/subscription-runtime.js";
import { terminalLineText } from "../../shared/terminal-text.js";
import { promptVaultPassword } from "./project-prompt.js";

/** Providers exposed by the subscription sign-in commands. */
export type SubscriptionProvider = "chatgpt" | "claude";

interface ProviderDefinition {
  readonly name: string;
  readonly piId: string;
}

const PROVIDERS: Readonly<Record<SubscriptionProvider, ProviderDefinition>> = {
  chatgpt: { name: "ChatGPT", piId: "openai-codex" },
  claude: { name: "Claude", piId: "anthropic" }
};

class AuthPromptCancelledError extends Error {
  constructor() {
    super("Sign-in prompt cancelled");
    this.name = "AbortError";
  }
}

/** The small part of Pi Models that the command needs. */
export interface AuthCliModels {
  readonly login: MutableModels["login"];
  readonly logout: MutableModels["logout"];
}

/** The small part of the machine-tier store that status needs. */
export interface AuthCliCredentials {
  readonly read: CredentialStore["read"];
}

/** Production code supplies these from the core subscription helper. */
export interface AuthCliDependencies {
  readonly models: AuthCliModels;
  readonly credentials: AuthCliCredentials;
}

export interface AuthCliStreams {
  readonly input: NodeJS.ReadStream;
  readonly output: AuthCliOutput;
  readonly errorOutput: AuthCliOutput;
}

export interface AuthCliOutput {
  readonly write: (text: string) => unknown;
  readonly isTTY?: boolean;
}

export interface AuthCliOptions {
  readonly dependencies?: AuthCliDependencies;
  readonly streams?: Partial<AuthCliStreams>;
  /** Test seam for the confirmation before OAuth starts. */
  readonly confirm?: () => Promise<boolean>;
  /** Test seam for Pi prompts and notifications. */
  readonly interaction?: AuthInteraction;
  readonly now?: () => number;
}

export interface ParsedAuthCommand {
  readonly action: "login" | "status" | "logout";
  readonly provider?: SubscriptionProvider;
}

const DEFAULT_STREAMS: AuthCliStreams = {
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr
};

let configuredDependencies: AuthCliDependencies | undefined;

/** Install the core subscription helper used by the standalone command. */
export function configureAuthCliDependencies(
  dependencies: AuthCliDependencies
): void {
  configuredDependencies = dependencies;
}

/** Clear the production dependency in tests or before a runtime restart. */
export function clearAuthCliDependencies(): void {
  configuredDependencies = undefined;
}

/** Parse the part of the command after `auth`. */
export function parseAuthCommand(argv: readonly string[]): ParsedAuthCommand {
  const action = argv[0];
  if (action === "status") {
    if (argv.length !== 1) throw new Error("auth status does not accept options");
    return { action };
  }
  if (action === "login" || action === "logout") {
    if (argv.length !== 2) {
      throw new Error(`auth ${action} requires chatgpt or claude`);
    }
    const provider = parseProvider(argv[1]);
    return { action, provider };
  }
  throw new Error(
    "auth requires login <chatgpt|claude>, status, or logout <chatgpt|claude>. "
      + "Use 1667 auth --help for auth show and other commands."
  );
}

/** Run a subscription authentication command. */
export async function runAuthCommand(
  argv: readonly string[],
  options: AuthCliOptions = {}
): Promise<void> {
  const command = parseAuthCommand(argv);
  const dependencies = options.dependencies
    ?? configuredDependencies
    ?? await createProductionAuthCliDependencies(command.action);
  const streams = { ...DEFAULT_STREAMS, ...(options.streams ?? {}) };
  switch (command.action) {
    case "status":
      await runAuthStatus(dependencies, streams.output, options.now ?? Date.now);
      return;
    case "login":
      await runAuthLogin(command.provider!, dependencies, streams, options);
      return;
    case "logout":
      await runAuthLogout(command.provider!, dependencies, streams.output);
      return;
  }
}

/** Build the production coordinator around the private machine-tier store. */
async function createProductionAuthCliDependencies(
  action: ParsedAuthCommand["action"]
): Promise<AuthCliDependencies> {
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

async function runAuthLogin(
  provider: SubscriptionProvider,
  dependencies: AuthCliDependencies,
  streams: AuthCliStreams,
  options: AuthCliOptions
): Promise<void> {
  const definition = PROVIDERS[provider];
  streams.output.write(loginNotice(definition.name));
  let confirmed: boolean;
  try {
    confirmed = options.confirm !== undefined
      ? await options.confirm()
      : options.interaction !== undefined
        ? await confirmInjectedInteraction(options.interaction)
        : await confirmLogin(definition.name, streams);
  } catch (error) {
    if (error instanceof AuthPromptCancelledError) {
      streams.output.write(
        "Sign-in cancelled. Existing local credential was not changed.\n"
      );
      return;
    }
    throw error;
  }
  if (!confirmed) {
    streams.output.write("Sign-in cancelled. Existing local credential was not changed.\n");
    return;
  }

  const interaction = options.interaction
    ?? createTerminalAuthInteraction(streams.input, streams.output);
  try {
    await dependencies.models.login(definition.piId, "oauth", interaction);
  } catch (error) {
    if (error instanceof AuthPromptCancelledError) {
      streams.output.write(
        "Sign-in cancelled. Existing local credential was not changed.\n"
      );
      return;
    }
    // Provider errors can contain access or refresh tokens. Keep this message
    // fixed even when a provider returns a detailed error.
    throw new Error(
      `Could not sign in to ${definition.name}. Try again or use an API key connection.`
    );
  }
  streams.output.write(`${definition.name} sign-in complete.\n`);
}

async function runAuthStatus(
  dependencies: AuthCliDependencies,
  output: AuthCliOutput,
  now: () => number
): Promise<void> {
  for (const provider of subscriptionProviders()) {
    const definition = PROVIDERS[provider];
    let credential: Credential | undefined;
    try {
      // Deliberately read the store, rather than Models.getAuth/checkAuth:
      // status must not refresh or make a provider request.
      credential = await dependencies.credentials.read(definition.piId);
    } catch (error) {
      if (error instanceof SubscriptionCredentialInvalidError) {
        credential = undefined;
      } else {
        throw new Error(`Could not read ${definition.name} sign-in status.`);
      }
    }
    const status = !isUsableOAuthCredential(credential)
      ? "signed out"
      : credential.expires <= now()
        ? "signed in (refreshes on next use)"
        : "signed in";
    output.write(`${definition.name}: ${status}\n`);
  }
}

async function runAuthLogout(
  provider: SubscriptionProvider,
  dependencies: AuthCliDependencies,
  output: AuthCliOutput
): Promise<void> {
  const definition = PROVIDERS[provider];
  try {
    await dependencies.models.logout(definition.piId);
  } catch {
    throw new Error(`Could not sign out of ${definition.name}.`);
  }
  output.write(
    `${definition.name} credential removed from this machine. `
      + "Remote token revocation is not promised.\n"
  );
}

function parseProvider(value: string | undefined): SubscriptionProvider {
  if (value === "chatgpt" || value === "claude") return value;
  throw new Error("provider must be chatgpt or claude");
}

function subscriptionProviders(): readonly SubscriptionProvider[] {
  return ["chatgpt", "claude"];
}

function loginNotice(providerName: string): string {
  return [
    `Experimental community integration: ${providerName} subscription sign-in.`,
    `It uses your ${providerName} subscription limits.`,
    `Your story text and generated text go to ${providerName} under its terms and data controls.`,
    "The provider can change or stop this flow without notice.",
    `An API key connection for ${providerName} remains available.`,
    ""
  ].join("\n");
}

async function confirmLogin(
  providerName: string,
  streams: AuthCliStreams
): Promise<boolean> {
  if (streams.input.isTTY !== true || streams.output.isTTY !== true) {
    throw new Error(
      `auth login ${providerName.toLowerCase()} requires a TTY confirmation`
    );
  }
  const readline = await import("node:readline/promises");
  const prompt = readline.createInterface({
    input: streams.input,
    output: streams.output as NodeJS.WritableStream
  });
  try {
    const answer = await prompt.question(
      `Continue with ${providerName} sign-in? [y/N] `
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    prompt.close();
  }
}

async function confirmInjectedInteraction(interaction: AuthInteraction): Promise<boolean> {
  const answer = await interaction.prompt({
    type: "select",
    message: "Continue with subscription sign-in?",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" }
    ]
  });
  return answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y";
}

/** Bridge Pi's prompts and events to the terminal without opening a browser. */
export function createTerminalAuthInteraction(
  input: NodeJS.ReadStream,
  output: AuthCliOutput
): AuthInteraction {
  return {
    prompt: async (prompt) => await promptTerminalAuth(input, output, prompt),
    notify: (event) => notifyTerminalAuth(output, event)
  };
}

async function promptTerminalAuth(
  input: NodeJS.ReadStream,
  output: AuthCliOutput,
  prompt: AuthPrompt
): Promise<string> {
  if (prompt.type === "secret") {
    const message = terminalLineText(prompt.message);
    const placeholder = prompt.placeholder === undefined
      ? undefined
      : terminalLineText(prompt.placeholder);
    try {
      return await promptVaultPassword(
        { input, output: output as NodeJS.WriteStream },
        `${message}${placeholder === undefined ? "" : ` (${placeholder})`}: `
      );
    } catch (error) {
      if (isTerminalPromptCancellation(error)) {
        throw new AuthPromptCancelledError();
      }
      throw error;
    }
  }
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("subscription sign-in prompts require a TTY");
  }
  const readline = await import("node:readline/promises");
  const promptReader = readline.createInterface({
    input,
    output: output as NodeJS.WritableStream
  });
  try {
    const question = async (query: string): Promise<string> => {
      try {
        return prompt.signal === undefined
          ? await promptReader.question(query)
          : await promptReader.question(query, { signal: prompt.signal });
      } catch (error) {
        if (isTerminalPromptCancellation(error)) {
          throw new AuthPromptCancelledError();
        }
        throw error;
      }
    };
    if (prompt.type === "select") {
      output.write(`\n${terminalLineText(prompt.message)}\n`);
      prompt.options.forEach((option, index) => {
        output.write(`  ${index + 1}. ${terminalLineText(option.label)}`);
        if (option.description !== undefined) {
          output.write(` — ${terminalLineText(option.description)}`);
        }
        output.write("\n");
      });
      if (prompt.options.length === 0) {
        throw new Error("invalid sign-in selection");
      }
      for (;;) {
        const answer = await question(`Choose 1-${prompt.options.length}: `);
        const normalized = answer.trim();
        const index = normalized === "" ? 0 : Number(normalized) - 1;
        const selected = Number.isInteger(index) ? prompt.options[index] : undefined;
        if (selected !== undefined) return selected.id;
        output.write("Choose a listed option.\n");
      }
    }
    const placeholder = prompt.placeholder === undefined
      ? ""
      : ` (${terminalLineText(prompt.placeholder)})`;
    return await question(`${terminalLineText(prompt.message)}${placeholder}: `);
  } finally {
    promptReader.close();
  }
}

function isTerminalPromptCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return error.message === "Vault Password prompt cancelled"
    || error.message === "Vault Password prompt input ended"
    || error.message === "Vault Password prompt input closed";
}

function notifyTerminalAuth(output: AuthCliOutput, event: AuthEvent): void {
  switch (event.type) {
    case "info":
      output.write(`${terminalLineText(event.message)}\n`);
      for (const link of event.links ?? []) {
        output.write(
          `${link.label === undefined ? "" : `${terminalLineText(link.label)}: `}`
            + `${terminalLineText(link.url)}\n`
        );
      }
      return;
    case "auth_url":
      output.write(
        `\nOpen this URL in your browser:\n${terminalUrl(output, event.url)}\n`
          + "1667 does not open a browser. Open the URL yourself, then complete sign-in.\n"
      );
      return;
    case "device_code":
      output.write(
        `\nOpen this URL in your browser:\n${terminalUrl(output, event.verificationUri)}\n`
          + `Enter code: ${terminalLineText(event.userCode)}\n`
      );
      return;
    case "progress":
      output.write(`${terminalLineText(event.message)}\n`);
      return;
  }
}

function terminalUrl(output: AuthCliOutput, url: string): string {
  const safeUrl = terminalLineText(url);
  if (output.isTTY !== true) return safeUrl;
  // Keep the literal URL inside the optional OSC 8 hyperlink. Terminals that
  // do not support hyperlinks still show the same plain text address.
  return `\u001b]8;;${safeUrl}\u001b\\${safeUrl}\u001b]8;;\u001b\\`;
}
