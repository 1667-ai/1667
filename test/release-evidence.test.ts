import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import {
  collectReleaseEvidence,
  type ReleaseEvidenceRequest
} from "../scripts/release-evidence.js";
import { createReleaseIdentitySet } from "../scripts/release-identity.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR_SOURCE = path.join(REPOSITORY_ROOT, "scripts", "release-evidence.ts");
const VERSION = "9.8.7";
const TAG = `v${VERSION}`;
const TIMESTAMP = "2026-07-27T08:09:10.011Z";
const FINGERPRINT = "SHA256:LtYSV9KYHYXvf8qGwf/HQDPsMehEsIQckR3N+wRB72k";

/**
 * The environment for the commands that *build* a fixture, which are ordinary
 * child processes of this test and would otherwise inherit a developer's signing
 * key, commit hooks and `gpg.format`. `collectReleaseEvidence` needs no
 * counterpart: it constructs its own hermetic environment, so nothing here is
 * neutralising a variable on production's behalf.
 */
const FIXTURE_GIT_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Release Bot",
  GIT_AUTHOR_EMAIL: "release@1667.test",
  GIT_AUTHOR_DATE: "2026-07-27T00:00:00+0000",
  GIT_COMMITTER_NAME: "Release Bot",
  GIT_COMMITTER_EMAIL: "release@1667.test",
  GIT_COMMITTER_DATE: "2026-07-27T00:00:00+0000"
});

type SignerName = "release" | "attacker" | "authority";

interface FixtureOptions {
  readonly rootVersion?: string;
  readonly tuiVersion?: string;
  readonly lockVersion?: string;
  readonly lockPackageVersion?: string;
  readonly tag?: "release-key" | "attacker-key" | "unsigned" | "lightweight";
  /**
   * `principals` names each signer's key directly. `certificate-authority`
   * names a CA and a principal pattern instead, and signs the tag with a
   * certificate — a form where the principal `ssh-keygen` reports appears
   * nowhere in the policy file.
   */
  readonly policy?: "principals" | "certificate-authority";
  /** Signers carried by the independently protected ref. */
  readonly policySigners?: readonly SignerName[];
  /**
   * Signers carried by `allowed-signers` in the released commit and working
   * tree. Every fixture ships the attacker's key here, so a collector that read
   * the policy off disk instead of from the protected ref would accept a tag the
   * protected ref never authorised.
   */
  readonly workingTreeSigners?: readonly SignerName[];
  readonly commitAfterTag?: boolean;
  readonly protectedRefBehind?: boolean;
  readonly dirty?: boolean;
}

interface Fixture {
  readonly repository: string;
}

/**
 * Builds a real repository with real SSH-signed tags, because a mock cannot show
 * that signature verification works.
 */
async function createFixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const git = async (
    args: readonly string[],
    extra: NodeJS.ProcessEnv = {}
  ): Promise<string> => {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: repository,
      encoding: "utf8",
      env: { ...FIXTURE_GIT_ENVIRONMENT, ...extra }
    });
    return stdout.trim();
  };
  const keygen = async (args: readonly string[]): Promise<void> => {
    await execFileAsync("ssh-keygen", [...args], { env: FIXTURE_GIT_ENVIRONMENT });
  };

  const keyPath = (name: SignerName): string => path.join(root, name);
  for (const name of ["release", "attacker", "authority"] as const) {
    await keygen(["-t", "ed25519", "-N", "", "-C", `${name}@1667.test`, "-f", keyPath(name), "-q"]);
  }
  const publicKey = (name: SignerName): string =>
    readFileSync(`${keyPath(name)}.pub`, "utf8").trim();
  const signerLine = (name: SignerName): string => `${name}@1667.test ${publicKey(name)}`;

  await mkdir(path.join(repository, "tui"), { recursive: true });
  await git(["init", "-q", "-b", "main", "."]);
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);

  const workingTreeSigners = options.workingTreeSigners ?? ["release", "attacker"];
  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "1667-workspace", version: options.rootVersion ?? VERSION }, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, "tui", "package.json"),
    `${JSON.stringify({ name: "1667-tui", version: options.tuiVersion ?? VERSION }, null, 2)}\n`
  );
  await writeFile(
    path.join(repository, "package-lock.json"),
    `${JSON.stringify({
      name: "1667-workspace",
      version: options.lockVersion ?? VERSION,
      lockfileVersion: 3,
      packages: { "": { name: "1667-workspace", version: options.lockPackageVersion ?? VERSION } }
    }, null, 2)}\n`
  );
  const certified = options.policy === "certificate-authority";
  const certificateAuthorityLine = (): string =>
    `*@1667.test cert-authority ${publicKey("authority")}`;
  await writeFile(
    path.join(repository, "allowed-signers"),
    `${[
      ...workingTreeSigners.map(signerLine),
      // A certified fixture mirrors the protected policy here too, so the one
      // thing it varies is where the principal comes from — not whether the
      // released commit happens to describe the same trust.
      ...(certified ? [certificateAuthorityLine()] : [])
    ].join("\n")}\n`
  );
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "release candidate"]);
  const releaseCommit = await git(["rev-parse", "HEAD"]);

  if (certified) {
    await keygen([
      "-s", keyPath("authority"),
      "-I", "release-bot",
      "-n", "release@1667.test",
      "-V", "-1d:+365d",
      `${keyPath("release")}.pub`
    ]);
  }
  const releaseSigningKey = certified
    ? `${keyPath("release")}-cert.pub`
    : `${keyPath("release")}.pub`;

  const tagKind = options.tag ?? "release-key";
  if (tagKind === "lightweight") {
    await git(["tag", TAG]);
  } else if (tagKind === "unsigned") {
    await git(["tag", "-a", "-m", TAG, TAG]);
  } else {
    const signingKey = tagKind === "release-key"
      ? releaseSigningKey
      : `${keyPath("attacker")}.pub`;
    await git([
      "-c", "gpg.format=ssh",
      "-c", `user.signingkey=${signingKey}`,
      "tag", "-s", "-m", TAG, TAG
    ]);
  }

  if (options.commitAfterTag === true) {
    await appendFile(path.join(repository, "README.md"), "after the tag\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "after the tag"]);
  }
  await git([
    "update-ref",
    "refs/remotes/origin/main",
    options.protectedRefBehind === true ? baseCommit : await git(["rev-parse", "HEAD"])
  ]);
  assert.notEqual(releaseCommit, baseCommit);

  const policyPath = path.join(root, "protected-allowed-signers");
  await writeFile(
    policyPath,
    certified
      ? `${certificateAuthorityLine()}\n`
      : `${(options.policySigners ?? ["release"]).map(signerLine).join("\n")}\n`
  );
  const blob = await git(["hash-object", "-w", "--", policyPath]);
  const indexFile = path.join(root, "policy.index");
  await git(["update-index", "--add", "--cacheinfo", `100644,${blob},allowed-signers`], {
    GIT_INDEX_FILE: indexFile
  });
  const tree = await git(["write-tree"], { GIT_INDEX_FILE: indexFile });
  const policyCommit = await git(["commit-tree", tree, "-m", "signer policy"]);
  await git(["update-ref", "refs/remotes/origin/release-policy", policyCommit]);

  if (options.dirty === true) {
    await appendFile(path.join(repository, "README.md"), "uncommitted\n");
  }
  return Object.freeze({ repository });
}

function collect(
  fixture: Fixture,
  overrides: Partial<ReleaseEvidenceRequest> = {}
): ReturnType<typeof collectReleaseEvidence> {
  return collectReleaseEvidence({
    repositoryRoot: fixture.repository,
    tagName: TAG,
    buildTimestamp: TIMESTAMP,
    ...overrides
  });
}

/**
 * Writes a program that answers `ssh-keygen -Y` without verifying anything: it
 * echoes back the principal Git asked about and exits zero. Git believes it, and
 * so would this module's interpreter — the only thing that keeps it out is that
 * the verifier is named by absolute path rather than resolved through `PATH`.
 */
async function plantForgedVerifier(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-forged-verifier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, "ssh-keygen");
  await writeFile(program, [
    "#!/bin/sh",
    "for argument in \"$@\"; do",
    "  case \"$argument\" in",
    "    find-principals) echo 'release@1667.test'; exit 0 ;;",
    `    verify) cat >/dev/null; echo 'Good "git" signature for release@1667.test`
      + ` with ED25519 key ${FINGERPRINT}'; exit 0 ;;`,
    "  esac",
    "done",
    "exit 0",
    ""
  ].join("\n"));
  await chmod(program, 0o755);
  return directory;
}

/**
 * Fixture repositories need `ssh-keygen` to mint signing keys, and on the
 * Windows runner it exits 255 before writing one when Node passes the empty
 * passphrase argument through `execFile`. Evidence is collected once per
 * release on the host that runs the release, which is not Windows, so these
 * integration fixtures are gated rather than the collector being reshaped
 * around a platform it does not run on. The interpretation they exercise —
 * including every adversarial signature-status form — is covered on all
 * platforms by `test/release-evidence-inspection.test.ts`, and the source scan
 * below is unconditional.
 */
const FIXTURE_ONLY = { skip: process.platform === "win32" } as const;

test("evidence from a signed tag on a protected branch satisfies the release validator", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t);
  const document = await collect(fixture);
  assert.equal(document.evidence.tagName, TAG);
  assert.equal(document.evidence.productVersion, VERSION);
  assert.equal(document.evidence.sourceDirty, false);
  assert.equal(document.evidence.tagObjectType, "annotated");
  assert.equal(document.evidence.tagSignature, "verified");
  assert.equal(document.evidence.buildTimestamp, TIMESTAMP);
  assert.equal(document.evidence.tagTargetCommit, document.evidence.sourceCommit);
  assert.match(document.evidence.sourceCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual({ ...document.evidence.packageVersions }, {
    root: VERSION,
    tui: VERSION,
    rootLock: VERSION,
    rootLockPackage: VERSION
  });
  assert.equal(document.signature.principal, "release@1667.test");
  assert.equal(document.signature.keyType, "ED25519");
  assert.match(document.signature.keyFingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);

  // Producer and validator cannot drift: the emitted document is exactly what a
  // release build consumes.
  const identities = createReleaseIdentitySet(
    JSON.parse(canonicalJson(document.evidence)) as unknown
  );
  assert.deepEqual(identities.evidence, document.evidence);
});

test("evidence refuses a tag signed by a key the protected ref never authorised", FIXTURE_ONLY, async (t) => {
  // The attacker key is valid, correctly formed, and listed in the repository's
  // own `allowed-signers` at the released commit. Only the protected ref decides
  // who may sign, so this must still be refused.
  const fixture = await createFixture(t, {
    tag: "attacker-key",
    policySigners: ["release"],
    workingTreeSigners: ["release", "attacker"]
  });
  const workingTreePolicy = readFileSync(
    path.join(fixture.repository, "allowed-signers"),
    "utf8"
  );
  assert.match(workingTreePolicy, /attacker@1667\.test/);
  await assert.rejects(collect(fixture), /is not from an allowed signer/);
});

test("evidence refuses a tag signed by a key absent from every allowed-signers file", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, {
    tag: "attacker-key",
    policySigners: ["release"],
    workingTreeSigners: ["release"]
  });
  await assert.rejects(collect(fixture), /is not from an allowed signer/);
});

test("evidence accepts a certificate-authority policy, whose principal is not in the file", FIXTURE_ONLY, async (t) => {
  // `ssh-keygen` matches principals; this module does not. The policy names the
  // CA and the pattern `*@1667.test`, and the principal that comes back —
  // `release@1667.test`, carried by the certificate — appears nowhere in it.
  const fixture = await createFixture(t, { policy: "certificate-authority" });
  const document = await collect(fixture);
  assert.equal(document.signature.principal, "release@1667.test");
  assert.equal(document.signature.keyType, "ED25519-CERT");
  assert.equal(document.evidence.tagSignature, "verified");
});

test("evidence verifies with the pinned verifier, not one planted on PATH", FIXTURE_ONLY, async (t) => {
  // No attacker key anywhere in the repository: the only way this tag can be
  // accepted is by asking a program that does not verify.
  const fixture = await createFixture(t, {
    tag: "attacker-key",
    workingTreeSigners: ["release"]
  });
  const planted = await plantForgedVerifier(t);

  // Reached only through `PATH`, the forgery is never run: the collector names
  // an absolute verifier, so the real one refuses the attacker's tag.
  await assert.rejects(
    collect(fixture, {
      environment: { PATH: `${planted}${path.delimiter}${process.env["PATH"] ?? ""}` }
    }),
    /is not from an allowed signer/
  );

  // And it is a forgery that works. Named outright, it is believed all the way
  // through — Git exits zero, the status line is the accepting form, and an
  // attacker-signed tag becomes a verified release. That is what a runner would
  // gain by choosing the verifier, which is why the assertion above is the
  // security property and `--ssh-keygen` is trusted input.
  const forged = await collect(fixture, { sshKeygenPath: path.join(planted, "ssh-keygen") });
  assert.equal(forged.signature.principal, "release@1667.test");
});

test("evidence refuses a verifier that is missing or not named absolutely", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    collect(fixture, { sshKeygenPath: "ssh-keygen" }),
    /must be an absolute path/
  );
  await assert.rejects(
    collect(fixture, { sshKeygenPath: path.join(tmpdir(), "1667-absent-ssh-keygen") }),
    /Release signature verifier was not found/
  );
});

test("evidence refuses a dirty working tree", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, { dirty: true });
  await assert.rejects(collect(fixture), /Release source tree is dirty/);
});

test("evidence refuses a lightweight tag", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, { tag: "lightweight" });
  await assert.rejects(collect(fixture), /is not an annotated tag object/);
});

test("evidence refuses an unsigned annotated tag", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, { tag: "unsigned" });
  await assert.rejects(collect(fixture), /carries no signature/);
});

test("evidence refuses a tag that does not point at the release commit", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, { commitAfterTag: true });
  await assert.rejects(collect(fixture), /does not point at the release commit/);
});

test("evidence refuses a release commit unreachable from the protected ref", FIXTURE_ONLY, async (t) => {
  const fixture = await createFixture(t, { protectedRefBehind: true });
  await assert.rejects(
    collect(fixture),
    /is not reachable from protected ref refs\/remotes\/origin\/main/
  );
});

test("evidence refuses disagreeing versions across manifests and the lockfile", FIXTURE_ONLY, async (t) => {
  for (const skew of [
    { rootVersion: "9.8.6" },
    { tuiVersion: "9.8.6" },
    { lockVersion: "9.8.6" },
    { lockPackageVersion: "9.8.6" }
  ]) {
    const fixture = await createFixture(t, skew);
    await assert.rejects(collect(fixture), /Release package versions disagree/);
  }
});

test("the evidence CLI emits canonical JSON the release validator accepts", FIXTURE_ONLY, async (t) => {
  // No environment is handed to the child on purpose: the collector builds its
  // own, so a developer's Git configuration must not be able to reach it.
  const fixture = await createFixture(t);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx",
    COLLECTOR_SOURCE,
    "--repository", fixture.repository,
    "--tag", TAG,
    "--build-timestamp", TIMESTAMP
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  const evidence: unknown = JSON.parse(stdout);
  assert.equal(canonicalJson(evidence), stdout.trim());
  assert.equal(createReleaseIdentitySet(evidence).evidence.tagName, TAG);
  assert.match(stderr, /release-tag-signer release@1667\.test SHA256:/);
});

test("the evidence collector reads no file", () => {
  // The fixtures above are the stronger guard — each writes the attacker's key
  // into the released commit, so a collector that read the policy off disk fails
  // them. This is the cheap one that names the mistake directly, since nothing
  // in this repository lints for it.
  const source = readFileSync(COLLECTOR_SOURCE, "utf8");
  for (const reader of ["readFile", "readFileSync", "createReadStream"]) {
    assert.equal(
      source.includes(reader),
      false,
      `scripts/release-evidence.ts must learn nothing from ${reader}; ask Git instead`
    );
  }
});
