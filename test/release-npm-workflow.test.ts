import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PUBLISHED_ARTIFACT_TARGETS } from "../shared/release-targets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(
  path.join(ROOT, ".github", "workflows", "release-npm.yml"),
  "utf8"
);
const GITHUB_RELEASE_WORKFLOW = readFileSync(
  path.join(ROOT, ".github", "workflows", "release-github.yml"),
  "utf8"
);
const OPERATION_WORKFLOW = readFileSync(
  path.join(ROOT, ".github", "workflows", "release-npm-operation.yml"),
  "utf8"
);
const CI_HELPER = readFileSync(path.join(ROOT, "scripts", "release-npm-ci.ts"), "utf8");

test("the npm workflow authorizes one dispatcher before the publication stages", () => {
  const triggers = WORKFLOW.slice(WORKFLOW.indexOf("on:\n"), WORKFLOW.indexOf("\npermissions:\n"));
  assert.match(WORKFLOW, /^name: Release \(npm\)$/mu);
  assert.match(triggers, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(triggers, /^  (?:push|pull_request|release):$/mu);
  assert.match(
    WORKFLOW,
    /^  group: \$\{\{ github\.triggering_actor == '10fra' && 'release-npm' \|\| format\('rejected-release-npm-\{0\}-\{1\}', github\.run_id, github\.run_attempt\) \}\}$/mu
  );
  assert.match(WORKFLOW, /^  cancel-in-progress: false$/mu);
  assert.match(WORKFLOW, /^  queue: max$/mu);
  const authorize = job("authorize");
  assert.match(authorize, /DISPATCHER: \$\{\{ github\.triggering_actor \}\}/u);
  assert.match(authorize, /test "\$DISPATCHER" = 10fra/u);
  assert.match(
    authorize,
    /collaborators\/\$DISPATCHER\/permission[\s\S]{0,80}--jq \.permission/u
  );
  assert.match(authorize, /test "\$permission" = admin/u);
  assert.deepEqual([...WORKFLOW.matchAll(/^  ([a-z][a-z-]*):$/gmu)].map((match) => {
    return match[1];
  }).filter((name) => ["build", "launcher", "preflight", "publish", "release"].includes(name!)), [
    "build",
    "launcher",
    "preflight",
    "publish",
    "release"
  ]);
  assert.match(job("build"), /^    needs: authorize$/mu);
  assert.match(job("publish"), /^    environment: publish$/mu);
  assert.match(job("publish"), /^    timeout-minutes: 180$/mu);
  assert.match(job("publish"), /^      id-token: write$/mu);
  assert.match(job("release"), /refs\/tags\/released\/v\$VERSION/u);
  for (const name of ["build", "publish"] as const) {
    assert.match(job(name), /GITHUB_REF.*refs\/tags\/v\$VERSION/u);
  }
});

test("the npm release dispatch binds to the signed tag commit", () => {
  // A dispatch on the default branch takes GITHUB_SHA from the branch tip, so a
  // merge after the maintainer signs the tag moves the source commit. The
  // dispatch ref is the signed tag, which no later merge can move.
  assert.match(WORKFLOW, /The dispatch ref must be the\n\s+signed v<version> tag\./u);
  for (const name of ["build", "publish"] as const) {
    const body = job(name);
    assert.match(body, /VERSION: \$\{\{ inputs\.version \}\}/u);
    assert.match(body, /if \[ "\$GITHUB_REF" != "refs\/tags\/v\$VERSION" \]; then/u);
  }
  assert.doesNotMatch(WORKFLOW, /"\$GITHUB_REF" != "refs\/heads\//u);
  // Reachability from the protected default branch is now the only control that
  // keeps an unmerged tag out of a release, so every job that collects source
  // evidence must fetch that branch.
  for (const name of ["build", "launcher", "preflight", "publish", "release"] as const) {
    const body = job(name);
    assert.match(body, /release-evidence\.ts/u);
    assert.match(
      body,
      /\+refs\/heads\/\$DEFAULT_BRANCH:refs\/remotes\/origin\/\$DEFAULT_BRANCH/u
    );
  }
});

test("OIDC jobs install no dependency lifecycle scripts", () => {
  for (const name of ["build", "launcher", "preflight", "publish"] as const) {
    const body = job(name);
    assert.match(body, /^      id-token: write$/mu);
    for (const match of body.matchAll(/^[ \t]*run: (npm ci.*)$/gmu)) {
      assert.match(match[1]!, /--ignore-scripts/u, `${name} ran scripts`);
    }
    for (const match of body.matchAll(/^[ \t]*run: (bun install.*)$/gmu)) {
      assert.match(match[1]!, /--ignore-scripts/u, `${name} ran Bun scripts`);
    }
  }
  assert.match(job("build"), /bun install --frozen-lockfile --ignore-scripts/u);
});

test("every retained release input is attested and verified before use", () => {
  assert.match(job("build"), /Attest the native result before upload/u);
  assert.match(job("launcher"), /Attest the release packages/u);
  assert.match(job("preflight"), /Verify every package attestation before preflight/u);
  assert.match(job("preflight"), /Attest the preflight result/u);
  assert.match(job("publish"), /Verify every retained input before publication/u);
  assert.match(job("release"), /Verify every retained input/u);
  // Native matrix results stay a fixed 10-file handoff. Later jobs derive the
  // exact retained count from the version and canonical release policy.
  assert.match(job("launcher"), /verify-attestations dist\/native 10/u);
  for (const name of ["preflight", "publish", "release"] as const) {
    assert.match(job(name), /expected(?:LauncherPackage|Publication)FileCount/u);
    assert.match(
      job(name),
      /verify-attestations dist\/(?:packages|publication) "\$count"/u
    );
    assert.match(job(name), /Expected \$count .* found \$found/u);
  }
  assert.match(job("launcher"), /release-install-script\.ts render/u);
  assert.match(job("launcher"), /dist\/archives\/\*\.tar\.gz/u);
  assert.match(job("launcher"), /dist\/installers\/\*/u);
  assert.match(job("release"), /dist\/publication\/archives\/\*\.tar\.gz/u);
  assert.match(job("release"), /dist\/publication\/installers\/\*/u);
  assert.match(CI_HELPER, /"--signer-workflow"/u);
  assert.match(CI_HELPER, /"--source-digest"/u);
  assert.match(CI_HELPER, /"--deny-self-hosted-runners"/u);
  const build = job("build");
  const nativeAttestation = workflowStep("build", "Attest the native result before upload");
  assert.match(
    nativeAttestation,
    /^        uses: actions\/attest-build-provenance@[0-9a-f]{40} # v4\.1\.1$/mu
  );
  assert.match(
    nativeAttestation,
    /^            dist\/builds\/\$\{\{ matrix\.target \}\}\/\*$/mu
  );
  assert.match(
    nativeAttestation,
    /^            dist\/observations\/\$\{\{ matrix\.target \}\}\.json$/mu
  );
  assert.doesNotMatch(nativeAttestation, /^        run:/mu);
  assert.ok(
    build.indexOf("Observe the native executable")
      < build.indexOf("Attest the native result before upload")
  );
  assert.ok(
    build.indexOf("Attest the native result before upload")
      < build.indexOf("Upload the native result")
  );
  const launcher = job("launcher");
  assert.ok(
    launcher.indexOf("Download every native result")
      < launcher.indexOf("Verify the native result attestations")
  );
  assert.ok(
    launcher.indexOf("Verify the native result attestations")
      < launcher.indexOf("Stage the packages")
  );
});

test("pack and publish jobs pin tools and publication has no npm token", () => {
  for (const name of ["launcher", "publish", "release"] as const) {
    const body = job(name);
    assert.match(body, /npm install --global "npm@\$NPM_VERSION" --ignore-scripts/u);
    assert.match(body, /test "\$\(node --version\)" = "v\$NODE_VERSION"/u);
    assert.match(body, /test "\$\(npm --version\)" = "\$NPM_VERSION"/u);
  }
  for (const name of ["build", "launcher", "preflight", "publish", "release"] as const) {
    assert.match(job(name), /package-manager-cache: false/u);
    assert.doesNotMatch(job(name), /^\s+cache:/mu);
  }
  assert.match(job("publish"), /npm run release:publish -- publish/u);
  assert.doesNotMatch(WORKFLOW, /NODE_AUTH_TOKEN|NPM_TOKEN|\._authToken/u);
  assert.match(job("preflight"), /release-completion\.ts ready/u);
  assert.match(job("publish"), /release-completion\.ts ready/u);
});

test("JSON-producing workflow commands suppress npm lifecycle output", () => {
  const launcher = job("launcher");
  assert.match(
    launcher,
    /npm run --silent release:stage[\s\S]{0,200}\\\n[ \t]+> dist\/stage\.json/u
  );
  assert.match(
    launcher,
    /npm run --silent release:pack[\s\S]{0,120}\\\n[ \t]+> dist\/pack\.json/u
  );
});

test("inline TypeScript workflow programs run as ES modules", () => {
  for (const workflow of [WORKFLOW, GITHUB_RELEASE_WORKFLOW]) {
    assert.match(workflow, /\bnode --import tsx --input-type=module -e '/u);
    assert.doesNotMatch(workflow, /\bnode --import tsx -e '/u);
  }
});

test("archive producers force canonical ustar and disable macOS metadata copies", () => {
  const launcher = job("launcher");
  // Shell Installer physical validation rejects PAX/GNU/AppleDouble entries.
  assert.match(
    launcher,
    /COPYFILE_DISABLE=1 tar --format=ustar -czf "dist\/archives\/\$stem\.tar\.gz" -C dist\/archive-stage "\$stem"/u
  );
  assert.doesNotMatch(launcher, /(?<!format=ustar )-czf "dist\/archives\/\$stem\.tar\.gz"/u);
});

test("the build matrix is the canonical published target set", () => {
  const targetLine = /^        target: \[([^\]]+)\]$/mu.exec(job("build"));
  assert.ok(targetLine?.[1] !== undefined);
  assert.deepEqual(
    targetLine[1].split(",").map((target) => target.trim()),
    PUBLISHED_ARTIFACT_TARGETS
  );
});

test("the retained layout and completion record support an exact rerun", () => {
  assert.match(job("launcher"), /cp dist\/native\/observations\/\*\.json dist\/observations\//u);
  assert.match(job("launcher"), /dist\/observations\/\*\.json/u);
  assert.doesNotMatch(WORKFLOW, /dist\/work\/plan\.json/u);
  for (const name of ["preflight", "publish", "release"] as const) {
    assert.match(job(name), /dist\/plan\.json/u);
  }
  assert.match(
    job("preflight"),
    /wc -l < dist\/work\/preflight\.log[\s\S]+!= 1[\s\S]+\^\[0-9a-f\]\{64\}\$/u
  );
  for (const name of ["build", "launcher", "preflight", "publish"] as const) {
    assert.match(job(name), /release-completion\.ts gate/u);
    assert.doesNotMatch(job(name), /release-completion\.ts replay/u);
  }
  assert.match(job("release"), /release-completion\.ts replay/u);
  assert.match(job("release"), /release-completion\.ts[\s\\]*status "\$VERSION"/u);
  assert.match(job("release"), /scripts\/release-npm-github\.ts/u);
  const record = job("release").indexOf("- name: Record complete publication");
  assert.ok(record > job("release").indexOf("scripts/release-npm-github.ts"));
  assert.equal(job("release").indexOf("- name:", record + 1), -1);
});

test("the immutable prerelease retains the durable promotion inputs", () => {
  const release = job("release");
  const observations = release.indexOf(
    "cp dist/publication/observations/*.json dist/assets/"
  );
  const publish = release.indexOf("scripts/release-npm-github.ts");
  assert.ok(observations !== -1 && observations < publish);
});

test("the safety interlock runs before signed source evidence is materialized", () => {
  for (const name of ["preflight", "publish", "release"] as const) {
    const body = job(name);
    const ready = body.indexOf("release-completion.ts ready");
    const evidence = body.indexOf("scripts/release-evidence.ts");
    assert.ok(ready !== -1 && ready < evidence, `${name} materialized evidence before interlock`);
  }
});

test("source evidence is collected before release artifacts dirty the checkout", () => {
  for (const name of ["launcher", "preflight", "publish", "release"] as const) {
    const body = job(name);
    const evidence = body.indexOf("scripts/release-evidence.ts");
    const download = body.indexOf("actions/download-artifact@");
    assert.ok(evidence !== -1 && evidence < download, `${name} downloaded before source evidence`);
  }
});

test("GitHub API and attestation reads have explicit authority", () => {
  assert.match(WORKFLOW, /^  actions: read$/mu);
  for (const name of ["launcher", "preflight", "publish", "release"] as const) {
    assert.match(job(name), /^      actions: read$/mu);
  }
  for (const name of ["publish", "release"] as const) {
    assert.match(job(name), /^      attestations: read$/mu);
  }
  for (const name of ["launcher", "preflight", "publish", "release"] as const) {
    const body = job(name);
    for (const match of body.matchAll(/verify-attestations/gmu)) {
      // Multiline steps keep GH_TOKEN in the step env block above the run body.
      const prefix = body.slice(Math.max(0, match.index - 1600), match.index);
      assert.match(prefix, /GH_TOKEN: \$\{\{ github\.token \}\}/u, `${name} omitted GH_TOKEN`);
    }
  }
});

test("the workflow pins the hosted GitHub CLI before project installs", () => {
  assert.doesNotMatch(WORKFLOW, /\/usr\/bin\/gh/u);
  assert.doesNotMatch(CI_HELPER, /ghExecutable = "\/usr\/bin\/gh"/u);
  for (const name of ["build", "launcher", "preflight", "publish", "release"] as const) {
    const body = job(name);
    const pin = body.indexOf("Pin the hosted GitHub CLI");
    const install = body.indexOf("npm ci");
    assert.ok(pin !== -1 && pin < install, `${name} pins gh after project install`);
  }
});

test("publication grants the publish job immutable-attempt authority", () => {
  assert.match(job("publish"), /^      contents: write$/mu);
  assert.match(job("publish"), /npm run release:publish -- publish/u);
});

test("authorized manual npm operations share the publication lock", () => {
  const triggers = OPERATION_WORKFLOW.slice(
    OPERATION_WORKFLOW.indexOf("on:\n"),
    OPERATION_WORKFLOW.indexOf("\npermissions:\n")
  );
  const header = OPERATION_WORKFLOW.slice(
    0,
    OPERATION_WORKFLOW.indexOf("\njobs:\n")
  );
  const authorize = operationJob("authorize");
  const hold = operationJob("hold");
  assert.match(OPERATION_WORKFLOW, /^name: Hold npm operation$/mu);
  assert.match(triggers, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(triggers, /^  (?:push|pull_request|release):$/mu);
  assert.match(WORKFLOW, /^  cancel-in-progress: false$/mu);
  assert.match(WORKFLOW, /^  queue: max$/mu);
  assert.doesNotMatch(header, /^concurrency:$/mu);
  assert.doesNotMatch(authorize, /^    concurrency:$/mu);
  assert.match(hold, /^    needs: authorize$/mu);
  assert.match(hold, /^    concurrency:$/mu);
  assert.match(
    hold,
    /needs\.authorize\.outputs\.authorization == format\('\{0\}:\{1\}:\{2\}', github\.run_id, github\.run_attempt, github\.triggering_actor\) && 'release-npm'/u
  );
  assert.match(
    hold,
    /format\('rejected-npm-operation-\{0\}-\{1\}', github\.run_id, github\.run_attempt\)/u
  );
  assert.match(hold, /^      cancel-in-progress: false$/mu);
  assert.match(hold, /^      queue: max$/mu);
  assert.match(OPERATION_WORKFLOW, /\$\{\{ inputs\.request_id \}\}/u);
  assert.match(
    OPERATION_WORKFLOW,
    /run-name:[\s\S]{0,180}source \$\{\{ inputs\.source_commit \}\}/u
  );
  assert.match(hold, /^    environment: npm-operations$/mu);
  assert.doesNotMatch(authorize, /^    environment:/mu);
  assert.match(OPERATION_WORKFLOW, /^  actions: read$/mu);
  assert.match(OPERATION_WORKFLOW, /^  contents: read$/mu);
  assert.doesNotMatch(OPERATION_WORKFLOW, /contents: write/u);
  assert.match(authorize, /GITHUB_REF.*refs\/heads\/\$DEFAULT_BRANCH/u);
  assert.match(
    authorize,
    /release-npm-operation-lease-cli\.ts \\\n\s+authorize/u
  );
  assert.match(authorize, /DISPATCHER: \$\{\{ github\.triggering_actor \}\}/u);
  assert.match(authorize, /REQUEST_ID: \$\{\{ inputs\.request_id \}\}/u);
  assert.ok(authorize.includes(
    '[[ "$REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}'
      + '-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]'
  ));
  assert.match(authorize, /"\$SOURCE_COMMIT" "\$DISPATCHER"/u);
  assert.match(hold, /process\.argv = \[process\.execPath, holder, "holder", \.\.\.args\]/u);
  assert.match(authorize, /npm ci --ignore-scripts/u);
  assert.doesNotMatch(hold, /(?:npm (?:ci|install)|actions\/checkout|actions\/setup-node|^[ \t]+uses:)/mu);
  assert.doesNotMatch(OPERATION_WORKFLOW, /id-token: write/u);
});

test("targeted hold reruns cannot reuse prior authorization", () => {
  const authorize = operationJob("authorize");
  const hold = operationJob("hold");
  assert.match(
    authorize,
    /authorization=%s:%s:%s\\n'[\s\S]+GITHUB_RUN_ID" "\$GITHUB_RUN_ATTEMPT" "\$DISPATCHER/u
  );
  assert.match(
    hold,
    /AUTHORIZATION: \$\{\{ needs\.authorize\.outputs\.authorization \}\}/u
  );
  assert.match(
    hold,
    /EXPECTED="\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT:\$DISPATCHER"[\s\S]{0,80}test "\$AUTHORIZATION" = "\$EXPECTED"/u
  );
  assert.match(
    hold,
    /rejected-npm-operation-\{0\}-\{1\}[\s\S]{0,100}github\.run_id, github\.run_attempt/u
  );
});

test("the locked holder verifies one prebuilt dependency-free bundle", () => {
  const authorize = operationJob("authorize");
  const hold = operationJob("hold");
  assert.match(authorize, /test "\$\(npx --no-install esbuild --version\)" = "0\.28\.1"/u);
  assert.match(authorize, /--bundle --format=esm --platform=node --target=node20/u);
  assert.match(authorize, /gzipSync\(source, \{ level: 9 \}\)/u);
  assert.match(authorize, /createHash\("sha256"\)\.update\(source\)\.digest\("hex"\)/u);
  assert.match(hold, /compressed\.toString\("base64"\) !== encoded/u);
  assert.match(hold, /gunzipSync\(compressed, \{ maxOutputLength: 512 \* 1024 \}\)/u);
  assert.match(hold, /digest !== expectedDigest/u);
  assert.match(hold, /writeFileSync\(holder, source, \{ flag: "wx", mode: 0o500 \}\)/u);
  assert.match(hold, /^[ \t]*if \(typeof AbortSignal\.any !== "function"\)/mu);
  assert.match(
    hold,
    /NPM_OPERATION_LOCK_STARTED_AT_MS: \$\{\{ steps\.lock\.outputs\.lock_started_at_ms \}\}/u
  );
});

test("publication rechecks protected state immediately before npm writes", () => {
  const publish = job("publish");
  const command = publish.indexOf("npm run release:publish -- publish");
  const completionFetch = publish.lastIndexOf(
    "git fetch origin '+refs/tags/released/*:refs/tags/released/*'",
    command
  );
  const completionGate = publish.lastIndexOf(
    "release-completion.ts gate",
    command
  );
  assert.ok(
    completionFetch !== -1 && completionFetch < completionGate
      && completionGate < command
  );
});

test("third-party actions use immutable commit pins", () => {
  const uses = [...`${WORKFLOW}\n${OPERATION_WORKFLOW}`.matchAll(
    /^[ \t]*uses: ([^@\s]+)@([^\s]+)(?: #.*)?$/gmu
  )];
  assert.ok(uses.length > 0);
  for (const match of uses) {
    assert.match(match[2]!, /^[0-9a-f]{40}$/u, match[0]);
  }
});

function job(
  name: "authorize" | "build" | "launcher" | "preflight" | "publish" | "release"
): string {
  const start = WORKFLOW.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1);
  const next = WORKFLOW.slice(start + 1).search(/^  [a-z][a-z-]*:\n/mu);
  return next === -1
    ? WORKFLOW.slice(start)
    : WORKFLOW.slice(start, start + 1 + next);
}

function operationJob(name: "authorize" | "hold"): string {
  const start = OPERATION_WORKFLOW.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1);
  const next = OPERATION_WORKFLOW.slice(start + 1).search(/^  [a-z][a-z-]*:\n/mu);
  return next === -1
    ? OPERATION_WORKFLOW.slice(start)
    : OPERATION_WORKFLOW.slice(start, start + 1 + next);
}

function workflowStep(
  jobName: "build" | "launcher" | "preflight" | "publish" | "release",
  stepName: string
): string {
  const body = job(jobName);
  const start = body.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1);
  const next = body.slice(start + 1).indexOf("\n      - name:");
  return next === -1
    ? body.slice(start)
    : body.slice(start, start + 1 + next);
}
