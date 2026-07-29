import assert from "node:assert/strict";
import test from "node:test";
import {
  NPM_OPERATION_CREATION_RULESET,
  NPM_OPERATION_ENVIRONMENT,
  NPM_OPERATION_IMMUTABLE_RULESET,
  NPM_OPERATION_OPEN_IMMUTABLE_RULESET,
  NPM_OPERATION_OPEN_LIFECYCLE_RULESET,
  NPM_OPERATION_OPEN_REF_PATTERN,
  NPM_OPERATION_REF_PATTERN,
  verifyNpmOperationRepositoryControls
} from "../scripts/release-npm-operation-controls.js";

const REPOSITORY = "1667-ai/1667";
const BASE = `https://api.github.test/repos/${REPOSITORY}`;

test("repository controls bind operation refs to main and trusted creators", async () => {
  const requested: string[] = [];
  await verifyNpmOperationRepositoryControls({
    apiUrl: "https://api.github.test/",
    fetch: controlFetch({}, requested),
    repository: REPOSITORY,
    token: "token"
  });
  assert.deepEqual(requested, [
    `${BASE}/environments/${NPM_OPERATION_ENVIRONMENT}`,
    `${BASE}/environments/${NPM_OPERATION_ENVIRONMENT}`
      + "/deployment-branch-policies?per_page=100",
    `${BASE}/rulesets?per_page=100&page=1`,
    `${BASE}/rulesets/11`,
    `${BASE}/rulesets/12`,
    `${BASE}/rulesets/13`,
    `${BASE}/rulesets/14`
  ]);
});

test("repository controls reject an environment that is not main-only", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      policies: {
        branch_policies: [
          { id: 1, name: "main", type: "branch" },
          { id: 2, name: "release/*", type: "branch" }
        ],
        total_count: 2
      }
    })),
    /must allow only main/u
  );
});

test("repository controls require a custom deployment branch policy", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      environment: {
        deployment_branch_policy: {
          custom_branch_policies: false,
          protected_branches: false
        },
        name: NPM_OPERATION_ENVIRONMENT,
        protection_rules: [{ id: 1, type: "branch_policy" }]
      }
    })),
    /require a custom branch policy/u
  );
});

test("repository controls reject an extra deployment reviewer", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      environment: {
        deployment_branch_policy: {
          custom_branch_policies: true,
          protected_branches: false
        },
        name: NPM_OPERATION_ENVIRONMENT,
        protection_rules: [
          { id: 1, type: "branch_policy" },
          { id: 2, type: "required_reviewers" }
        ]
      }
    })),
    /unexpected protection rules/u
  );
});

test("repository controls reject operation creation by another actor", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      creation: ruleset(
        11,
        NPM_OPERATION_CREATION_RULESET,
        ["creation"],
        [{ actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" }]
      )
    })),
    /wrong bypass actors/u
  );
});

test("repository controls reject mutable operation refs", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      immutable: ruleset(
        12,
        NPM_OPERATION_IMMUTABLE_RULESET,
        ["deletion", "update"],
        []
      )
    })),
    /wrong rules/u
  );
});

test("repository controls restrict the open-marker lifecycle", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      openLifecycle: ruleset(
        13,
        NPM_OPERATION_OPEN_LIFECYCLE_RULESET,
        ["creation"],
        trustedCreators(),
        NPM_OPERATION_OPEN_REF_PATTERN
      )
    })),
    /wrong rules/u
  );
});

test("repository controls reject open-marker updates", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      openImmutable: ruleset(
        14,
        NPM_OPERATION_OPEN_IMMUTABLE_RULESET,
        ["update"],
        [],
        NPM_OPERATION_OPEN_REF_PATTERN
      )
    })),
    /wrong rules/u
  );
});

test("repository controls reject a shallow ref pattern", async () => {
  const value = ruleset(
    11,
    NPM_OPERATION_CREATION_RULESET,
    ["creation"],
    trustedCreators()
  );
  value.conditions.ref_name.include = ["refs/tags/npm-operations/*"];
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({ creation: value })),
    /does not target the operation refs/u
  );
});

test("repository controls require an active repository tag ruleset", async () => {
  const cases = [
    ["enforcement", "evaluate"],
    ["source", "1667-ai/other"],
    ["source_type", "Organization"],
    ["target", "branch"]
  ] as const;
  for (const [field, value] of cases) {
    const rules = ruleset(
      11,
      NPM_OPERATION_CREATION_RULESET,
      ["creation"],
      trustedCreators()
    );
    rules[field] = value;
    await assert.rejects(
      verifyNpmOperationRepositoryControls(options({ creation: rules })),
      /does not target the operation refs/u,
      field
    );
  }
});

test("repository controls reject exclusions from the operation namespace", async () => {
  const base = ruleset(
    11,
    NPM_OPERATION_CREATION_RULESET,
    ["creation"],
    trustedCreators()
  );
  const value = {
    ...base,
    conditions: {
      ref_name: {
        ...base.conditions.ref_name,
        exclude: ["refs/tags/npm-operations/quarantine/**"]
      }
    }
  };
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({ creation: value })),
    /does not target the operation refs/u
  );
});

test("repository controls require both named rulesets exactly once", async () => {
  await assert.rejects(
    verifyNpmOperationRepositoryControls(options({
      summaries: [
        { id: 11, name: NPM_OPERATION_CREATION_RULESET },
        { id: 13, name: NPM_OPERATION_CREATION_RULESET },
        { id: 12, name: NPM_OPERATION_IMMUTABLE_RULESET }
      ]
    })),
    /must exist exactly once/u
  );
});

interface Overrides {
  readonly environment?: unknown;
  readonly policies?: unknown;
  readonly summaries?: unknown;
  readonly creation?: unknown;
  readonly immutable?: unknown;
  readonly openLifecycle?: unknown;
  readonly openImmutable?: unknown;
}

function options(overrides: Overrides) {
  return {
    apiUrl: "https://api.github.test/",
    fetch: controlFetch(overrides),
    repository: REPOSITORY,
    token: "token"
  };
}

function controlFetch(
  overrides: Overrides,
  requested: string[] = []
): typeof fetch {
  return (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === `${BASE}/environments/${NPM_OPERATION_ENVIRONMENT}`) {
      return json(overrides.environment ?? {
        deployment_branch_policy: {
          custom_branch_policies: true,
          protected_branches: false
        },
        name: NPM_OPERATION_ENVIRONMENT,
        protection_rules: [{ id: 1, type: "branch_policy" }]
      });
    }
    if (url === `${BASE}/environments/${NPM_OPERATION_ENVIRONMENT}`
      + "/deployment-branch-policies?per_page=100") {
      return json(overrides.policies ?? {
        branch_policies: [{ id: 1, name: "main", type: "branch" }],
        total_count: 1
      });
    }
    if (url === `${BASE}/rulesets?per_page=100&page=1`) {
      return json(overrides.summaries ?? [
        { id: 11, name: NPM_OPERATION_CREATION_RULESET },
        { id: 12, name: NPM_OPERATION_IMMUTABLE_RULESET },
        { id: 13, name: NPM_OPERATION_OPEN_LIFECYCLE_RULESET },
        { id: 14, name: NPM_OPERATION_OPEN_IMMUTABLE_RULESET }
      ]);
    }
    if (url === `${BASE}/rulesets/11`) {
      return json(overrides.creation ?? ruleset(
        11,
        NPM_OPERATION_CREATION_RULESET,
        ["creation"],
        trustedCreators()
      ));
    }
    if (url === `${BASE}/rulesets/12`) {
      return json(overrides.immutable ?? ruleset(
        12,
        NPM_OPERATION_IMMUTABLE_RULESET,
        ["deletion", "non_fast_forward", "update"],
        []
      ));
    }
    if (url === `${BASE}/rulesets/13`) {
      return json(overrides.openLifecycle ?? ruleset(
        13,
        NPM_OPERATION_OPEN_LIFECYCLE_RULESET,
        ["creation", "deletion"],
        trustedCreators(),
        NPM_OPERATION_OPEN_REF_PATTERN
      ));
    }
    if (url === `${BASE}/rulesets/14`) {
      return json(overrides.openImmutable ?? ruleset(
        14,
        NPM_OPERATION_OPEN_IMMUTABLE_RULESET,
        ["non_fast_forward", "update"],
        [],
        NPM_OPERATION_OPEN_REF_PATTERN
      ));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

function ruleset(
  id: number,
  name: string,
  ruleTypes: readonly string[],
  bypassActors: readonly Record<string, unknown>[],
  pattern = NPM_OPERATION_REF_PATTERN
) {
  return {
    bypass_actors: bypassActors,
    conditions: {
      ref_name: { exclude: [], include: [pattern] }
    },
    enforcement: "active",
    id,
    name,
    rules: ruleTypes.map((type) => ({ type })),
    source: REPOSITORY,
    source_type: "Repository",
    target: "tag"
  };
}

function trustedCreators() {
  return [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }
  ];
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}
