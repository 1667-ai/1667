import { GitHubHttpTransport } from "./release-github-http.js";

const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_RULESET_PAGES = 10;
const RULESETS_PER_PAGE = 100;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export const NPM_OPERATION_ENVIRONMENT = "npm-operations";
export const NPM_OPERATION_REF_PATTERN = "refs/tags/npm-operations/**/*";
export const NPM_OPERATION_OPEN_REF_PATTERN =
  "refs/tags/npm-operations-open/**/*";
export const NPM_OPERATION_CREATION_RULESET =
  "tag: npm-operations creation";
export const NPM_OPERATION_IMMUTABLE_RULESET =
  "tag: npm-operations immutable";
export const NPM_OPERATION_OPEN_LIFECYCLE_RULESET =
  "tag: npm-operations-open lifecycle";
export const NPM_OPERATION_OPEN_IMMUTABLE_RULESET =
  "tag: npm-operations-open immutable";

const EXPECTED_CREATION_BYPASS = Object.freeze([
  "RepositoryRole:5:always"
]);
const EXPECTED_IMMUTABLE_RULES = Object.freeze([
  "deletion",
  "non_fast_forward",
  "update"
]);

export interface NpmOperationControlOptions {
  readonly repository: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
}

export async function verifyNpmOperationRepositoryControls(
  options: NpmOperationControlOptions
): Promise<void> {
  const client = new GitHubControlClient(options);
  await verifyEnvironment(client);
  const summaries = await client.rulesets();
  await verifyRuleset(
    client,
    uniqueRuleset(summaries, NPM_OPERATION_CREATION_RULESET),
    {
      bypass: EXPECTED_CREATION_BYPASS,
      pattern: NPM_OPERATION_REF_PATTERN,
      rules: ["creation"]
    }
  );
  await verifyRuleset(
    client,
    uniqueRuleset(summaries, NPM_OPERATION_IMMUTABLE_RULESET),
    {
      bypass: [],
      pattern: NPM_OPERATION_REF_PATTERN,
      rules: EXPECTED_IMMUTABLE_RULES
    }
  );
  await verifyRuleset(
    client,
    uniqueRuleset(summaries, NPM_OPERATION_OPEN_LIFECYCLE_RULESET),
    {
      bypass: EXPECTED_CREATION_BYPASS,
      pattern: NPM_OPERATION_OPEN_REF_PATTERN,
      rules: ["creation", "deletion"]
    }
  );
  await verifyRuleset(
    client,
    uniqueRuleset(summaries, NPM_OPERATION_OPEN_IMMUTABLE_RULESET),
    {
      bypass: [],
      pattern: NPM_OPERATION_OPEN_REF_PATTERN,
      rules: ["non_fast_forward", "update"]
    }
  );
}

interface RulesetSummary {
  readonly id: number;
  readonly name: string;
}

class GitHubControlClient {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;

  constructor(options: NpmOperationControlOptions) {
    if (!REPOSITORY.test(options.repository)) {
      throw new Error("npm operation control repository is invalid");
    }
    if (options.token === "") {
      throw new Error("npm operation control token is required");
    }
    this.#repository = options.repository;
    this.#http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal: options.requestSignal,
      maxResponseBytes: MAX_API_BYTES,
      userAgent: "1667-release-npm-operation-controls"
    });
  }

  get repository(): string {
    return this.#repository;
  }

  async environment(): Promise<Record<string, unknown>> {
    return object(
      await this.#get(
        `repos/${this.#repository}/environments/${NPM_OPERATION_ENVIRONMENT}`,
        "npm operation environment"
      ),
      "npm operation environment"
    );
  }

  async branchPolicies(): Promise<Record<string, unknown>> {
    return object(
      await this.#get(
        `repos/${this.#repository}/environments/${NPM_OPERATION_ENVIRONMENT}`
          + "/deployment-branch-policies?per_page=100",
        "npm operation branch policies"
      ),
      "npm operation branch policies"
    );
  }

  async rulesets(): Promise<readonly RulesetSummary[]> {
    const result: RulesetSummary[] = [];
    for (let page = 1; page <= MAX_RULESET_PAGES; page += 1) {
      const value = await this.#get(
        `repos/${this.#repository}/rulesets?per_page=${RULESETS_PER_PAGE}&page=${page}`,
        "npm operation rulesets"
      );
      if (!Array.isArray(value)) {
        throw new Error("npm operation rulesets must be an array");
      }
      result.push(...value.map(rulesetSummary));
      if (value.length < RULESETS_PER_PAGE) return Object.freeze(result);
    }
    throw new Error("npm operation rulesets exceed the pagination bound");
  }

  async ruleset(id: number): Promise<Record<string, unknown>> {
    return object(
      await this.#get(
        `repos/${this.#repository}/rulesets/${id}`,
        "npm operation ruleset"
      ),
      "npm operation ruleset"
    );
  }

  async #get(pathname: string, label: string): Promise<unknown> {
    const response = await this.#http.request(
      pathname,
      { method: "GET" },
      label
    );
    if (response.status !== 200) {
      throw new Error(`${label} returned ${response.status}`);
    }
    return this.#http.readJson(response, label);
  }
}

async function verifyEnvironment(client: GitHubControlClient): Promise<void> {
  const environment = await client.environment();
  const deployment = object(
    environment.deployment_branch_policy,
    "npm operation deployment policy"
  );
  if (environment.name !== NPM_OPERATION_ENVIRONMENT
    || deployment.protected_branches !== false
    || deployment.custom_branch_policies !== true) {
    throw new Error("npm operation environment does not require a custom branch policy");
  }
  if (!Array.isArray(environment.protection_rules)
    || environment.protection_rules.length !== 1
    || object(
      environment.protection_rules[0],
      "npm operation environment protection rule"
    ).type !== "branch_policy") {
    throw new Error("npm operation environment has unexpected protection rules");
  }

  const policies = await client.branchPolicies();
  if (policies.total_count !== 1 || !Array.isArray(policies.branch_policies)
    || policies.branch_policies.length !== 1) {
    throw new Error("npm operation environment must allow only main");
  }
  const policy = object(
    policies.branch_policies[0],
    "npm operation branch policy"
  );
  if (policy.name !== "main" || policy.type !== "branch") {
    throw new Error("npm operation environment must allow only the main branch");
  }
}

async function verifyRuleset(
  client: GitHubControlClient,
  summary: RulesetSummary,
  expected: {
    readonly bypass: readonly string[];
    readonly pattern: string;
    readonly rules: readonly string[];
  }
): Promise<void> {
  const ruleset = await client.ruleset(summary.id);
  const conditions = object(ruleset.conditions, `${summary.name} conditions`);
  const names = object(conditions.ref_name, `${summary.name} ref condition`);
  if (ruleset.name !== summary.name || ruleset.target !== "tag"
    || ruleset.source_type !== "Repository"
    || ruleset.source !== client.repository
    || ruleset.enforcement !== "active"
    || !sameStrings(names.include, [expected.pattern])
    || !sameStrings(names.exclude, [])) {
    throw new Error(`${summary.name} does not target the operation refs`);
  }
  if (!Array.isArray(ruleset.rules)
    || !sameStrings(
      ruleset.rules.map((rule) => object(rule, `${summary.name} rule`).type),
      expected.rules
    )) {
    throw new Error(`${summary.name} has the wrong rules`);
  }
  if (!Array.isArray(ruleset.bypass_actors)
    || !sameStrings(
      ruleset.bypass_actors.map((actor) => {
        const value = object(actor, `${summary.name} bypass actor`);
        return `${String(value.actor_type)}:${String(value.actor_id)}:`
          + String(value.bypass_mode);
      }),
      expected.bypass
    )) {
    throw new Error(`${summary.name} has the wrong bypass actors`);
  }
}

function uniqueRuleset(
  rulesets: readonly RulesetSummary[],
  name: string
): RulesetSummary {
  const matches = rulesets.filter((ruleset) => ruleset.name === name);
  if (matches.length !== 1) {
    throw new Error(`${name} must exist exactly once`);
  }
  return matches[0]!;
}

function rulesetSummary(value: unknown): RulesetSummary {
  const record = object(value, "npm operation ruleset summary");
  if (!Number.isSafeInteger(record.id) || Number(record.id) < 1
    || typeof record.name !== "string") {
    throw new Error("npm operation ruleset summary is invalid");
  }
  return Object.freeze({ id: Number(record.id), name: record.name });
}

function sameStrings(
  actual: unknown,
  expected: readonly string[]
): boolean {
  return Array.isArray(actual)
    && actual.every((value) => typeof value === "string")
    && [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
