import {
  NpmChildClient,
  type NpmCommandRunner
} from "./release-npm-child-client.js";
import {
  NpmProcessJournal,
  type NpmProcessJournalIdentity
} from "./release-npm-process-journal.js";
import { NpmRegistryPendingError } from "./release-npm-provenance.js";
import {
  NpmPublicClient
} from "./release-npm-public-client.js";
import {
  assertNoNpmOperationCredentialEnvironment,
  npmTagWriteArguments,
  type NpmPackageTagState,
  type NpmTagRegistry,
  type NpmTagWrite
} from "./release-npm-operations.js";

const NPM_WRITE_TIMEOUT_MS = 5 * 60_000;
const NPM_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
export interface NpmTagMetadataClient {
  read(name: string, version: string | null, label: string): Promise<unknown | null>;
}

export interface PublicNpmTagRegistryOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly authorizeWrite: () => Promise<void>;
  readonly metadata?: NpmTagMetadataClient;
  readonly writeTimeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly settleTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly processJournalPath?: string;
  readonly processIdentity?: NpmProcessJournalIdentity;
  readonly processJournal?: NpmProcessJournal;
  readonly independentTimeoutMs?: number;
  readonly runner?: NpmCommandRunner;
}

export class PublicNpmTagRegistry implements NpmTagRegistry {
  readonly #metadata: NpmTagMetadataClient;
  readonly #authorizeWrite: () => Promise<void>;
  readonly #settleTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #runner: NpmCommandRunner | null;

  constructor(options: PublicNpmTagRegistryOptions) {
    assertNoNpmOperationCredentialEnvironment(options.environment);
    this.#metadata = options.metadata ?? new NpmPublicClient();
    this.#authorizeWrite = options.authorizeWrite;
    const writeTimeoutMs = positiveDuration(
      options.writeTimeoutMs ?? NPM_WRITE_TIMEOUT_MS,
      "npm tag command timeout"
    );
    const terminationGraceMs = positiveDuration(
      options.terminationGraceMs ?? NPM_TERMINATION_GRACE_MS,
      "npm tag command termination grace"
    );
    const hasJournalPath = options.processJournalPath !== undefined;
    const hasJournalIdentity = options.processIdentity !== undefined;
    if (hasJournalPath !== hasJournalIdentity
      || (options.processJournal !== undefined
        && (hasJournalPath || hasJournalIdentity))) {
      throw new Error(
        "provide either an npm process journal or its path and identity"
      );
    }
    const processJournal = options.processJournal ?? (
      options.processJournalPath === undefined || options.processIdentity === undefined
        ? null
        : new NpmProcessJournal(options.processJournalPath, options.processIdentity)
    );
    this.#runner = options.runner ?? (
      processJournal === null
        ? null
        : new NpmChildClient({
            nodeExecutable: options.environment.npm_node_execpath ?? "",
            npmCli: options.environment.npm_execpath ?? "",
            environment: npmChildEnvironment(options.environment),
            journal: processJournal,
            writeTimeoutMs,
            terminationGraceMs,
            independentTimeoutMs: options.independentTimeoutMs
          })
    );
    this.#settleTimeoutMs = positiveDuration(
      options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      "npm tag settle timeout"
    );
    this.#pollIntervalMs = positiveDuration(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "npm tag poll interval"
    );
    this.#sleep = options.sleep ?? ((milliseconds) => {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
    this.#now = options.now ?? Date.now;
  }

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    const [packument, exact] = await Promise.all([
      this.#metadata.read(name, null, `${name} package metadata`),
      this.#metadata.read(name, version, `${name}@${version} metadata`)
    ]);
    if (packument === null) {
      if (exact !== null) {
        throw new Error(`npm registry returned ${name}@${version} without package metadata`);
      }
      return absentState(
        name,
        version,
        Object.freeze(Object.create(null) as Record<string, string>)
      );
    }
    const packageRecord = record(packument, `${name} package metadata`);
    if (packageRecord.name !== name) {
      throw new Error(`npm registry returned the wrong package for ${name}`);
    }
    const tagsRecord = record(packageRecord["dist-tags"], `${name} npm dist-tags`);
    const tags = Object.create(null) as Record<string, string>;
    for (const [tag, taggedVersion] of Object.entries(tagsRecord)) {
      if (tag === "" || typeof taggedVersion !== "string") {
        throw new Error(`${name} has invalid npm dist-tag metadata`);
      }
      tags[tag] = taggedVersion;
    }
    const frozenTags = Object.freeze(tags);
    if (exact === null) return absentState(name, version, frozenTags);
    const versionRecord = record(exact, `${name}@${version} metadata`);
    if (versionRecord.name !== name || versionRecord.version !== version) {
      throw new Error(`npm registry returned the wrong package for ${name}`);
    }
    let deprecated: string | null = null;
    if ("deprecated" in versionRecord) {
      if (typeof versionRecord.deprecated !== "string") {
        throw new Error(`${name}@${version} has invalid deprecation metadata`);
      }
      deprecated = versionRecord.deprecated === ""
        ? null
        : versionRecord.deprecated;
    }
    return Object.freeze({
      name,
      version,
      present: true,
      deprecated,
      tags: frozenTags
    });
  }

  async settleAbsence(): Promise<void> {
    await this.#sleep(this.#settleTimeoutMs);
  }

  async addTag(name: string, version: string, tag: string): Promise<void> {
    const write = { kind: "add" as const, name, version, tag };
    await this.#writeAndConfirm(
      write,
      (state) => state.present && state.tags[tag] === version
    );
  }

  async removeTag(name: string, version: string, tag: string): Promise<void> {
    const write = { kind: "remove" as const, name, version, tag };
    await this.#writeAndConfirm(
      write,
      (state) => state.tags[tag] !== version
    );
  }

  async deprecate(name: string, version: string, message: string): Promise<void> {
    const write = { kind: "deprecate" as const, name, version, message };
    await this.#writeAndConfirm(
      write,
      (state) => state.present && state.deprecated === message
    );
  }

  async #writeAndConfirm(
    write: NpmTagWrite,
    confirmed: (state: NpmPackageTagState) => boolean
  ): Promise<void> {
    if (this.#runner === null) {
      throw new Error("npm tag write requires a durable process journal");
    }
    requireWritePrecondition(
      await this.inspect(write.name, write.version),
      write
    );
    await this.#authorizeWrite();
    let writeError: unknown;
    try {
      await this.#write(npmTagWriteArguments(write));
    } catch (error) {
      writeError = error;
    }
    const deadline = this.#now() + this.#settleTimeoutMs;
    let lastError: unknown = new Error("npm registry did not show the tag write");
    while (this.#now() < deadline) {
      try {
        const state = await this.inspect(write.name, write.version);
        if (confirmed(state)) return;
        lastError = new Error(`${write.name}@${write.version} write is not visible`);
      } catch (error) {
        if (!(error instanceof NpmRegistryPendingError)) throw error;
        lastError = error;
      }
      await this.#sleep(this.#pollIntervalMs);
    }
    throw new Error(
      `${write.name}@${write.version} write was not confirmed by npm`,
      { cause: writeError ?? lastError }
    );
  }

  async #write(arguments_: readonly string[]): Promise<void> {
    await this.#runner!.run(arguments_);
  }
}

function requireWritePrecondition(
  state: NpmPackageTagState,
  write: NpmTagWrite
): void {
  if (write.kind === "add") {
    if (!state.present) {
      throw new Error(`npm registry does not contain ${write.name}@${write.version}`);
    }
    if (state.deprecated !== null) {
      throw new Error(`${write.name}@${write.version} is deprecated`);
    }
    if (state.tags.next !== write.version) {
      throw new Error(`${write.name} next tag changed before promotion`);
    }
    return;
  }
  if (write.kind === "remove") {
    if (state.tags[write.tag] !== write.version) {
      throw new Error(`${write.name} ${write.tag} tag changed before removal`);
    }
    return;
  }
  if (!state.present) {
    throw new Error(`npm registry does not contain ${write.name}@${write.version}`);
  }
  if (state.deprecated !== null && state.deprecated !== write.message) {
    throw new Error(`${write.name}@${write.version} deprecation changed before write`);
  }
}

function absentState(
  name: string,
  version: string,
  tags: Readonly<Record<string, string>>
): NpmPackageTagState {
  return Object.freeze({
    name,
    version,
    present: false,
    deprecated: null,
    tags
  });
}

function npmChildEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.GH_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.NPM_OPERATION_CLAIM_SECRET;
  delete child.NPM_OPERATION_WRITER_SECRET;
  return child;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
