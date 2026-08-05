#!/usr/bin/env -S node --import tsx

import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  PUBLISHED_ARTIFACT_TARGETS,
  PUBLISHED_PACKAGE_COUNT,
  type PublishedArtifactTarget
} from "../shared/release-targets.js";
import {
  type ReleaseArtifactManifest
} from "./release-artifact-manifest.js";
import { verifyRemoteReleaseTag } from "./release-github-tag.js";
import {
  GitHubNpmPublicationLedger
} from "./release-npm-ledger.js";
import {
  NpmReleaseRegistry
} from "./release-npm-registry.js";
import {
  publishNpmRelease,
  validatePublicationMatrix,
  type NpmPublicationPackage
} from "./release-npm-publisher.js";
import {
  parseReleasePackageManifest
} from "./release-package-policy.js";
import { runReleasePreflightFile } from "./release-preflight.js";
import {
  MAX_RELEASE_TARBALL_GZIP_BYTES,
  readReleaseTarball
} from "./release-tar-reader.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface GitHubPublicationEnvironment {
  readonly GITHUB_REPOSITORY?: string;
  readonly GH_TOKEN?: string;
}

export function githubPublicationAuthority(
  command: "publish" | "verify",
  environment: GitHubPublicationEnvironment
): {
  readonly repository: string;
  readonly token: string;
} | undefined {
  if (command === "verify") return undefined;
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GH_TOKEN;
  if (repository === undefined || token === undefined) {
    throw new Error("Release publication requires GitHub publication authority");
  }
  return Object.freeze({ repository, token });
}

export async function publicationPackages(
  planPath: string,
  expectedManifestPath: string,
  tarballDirectory: string
): Promise<{
  readonly manifest: ReleaseArtifactManifest;
  readonly packages: readonly NpmPublicationPackage[];
}> {
  const result = await runReleasePreflightFile(planPath);
  const expected = boundedTextFile(
    expectedManifestPath,
    MAX_MANIFEST_BYTES,
    "Release artifact manifest"
  );
  if (expected !== result.text) {
    throw new Error("Release artifact manifest does not match repeated preflight");
  }
  const directory = boundedDirectory(tarballDirectory);
  const names = readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  if (names.length !== PUBLISHED_PACKAGE_COUNT) {
    throw new Error(
      `Release publication needs exactly ${PUBLISHED_PACKAGE_COUNT} tarballs`
    );
  }
  const artifactByName = new Map(
    result.manifest.artifacts.map((artifact) => [artifact.name, artifact])
  );
  const packages = await Promise.all(names.map(async (name) => {
    if (!name.endsWith(".tgz") || path.basename(name) !== name) {
      throw new Error(`Release tarball directory contains unsupported entry ${name}`);
    }
    const file = boundedFile(
      path.join(directory, name),
      MAX_RELEASE_TARBALL_GZIP_BYTES,
      "Release tarball"
    );
    if (path.dirname(file) !== directory) {
      throw new Error(`Release tarball ${name} escaped its directory`);
    }
    const parsed = await readReleaseTarball(createReadStream(file));
    const manifest = parseReleasePackageManifest(
      parsed.packageManifest,
      result.manifest.productVersion
    );
    const artifact = artifactByName.get(manifest.name);
    if (artifact === undefined) {
      throw new Error(`Release artifact manifest is missing ${manifest.name}`);
    }
    if (parsed.gzip.sha256 !== artifact.tarball.sha256
      || parsed.gzip.bytes !== artifact.tarball.bytes) {
      throw new Error(`${manifest.name} tarball differs from the artifact manifest`);
    }
    const artifactTarget = manifest.kind === "launcher"
      ? "launcher"
      : publishedTarget(manifest.target);
    if (artifact.target !== artifactTarget) {
      throw new Error(`${manifest.name} target differs from the artifact manifest`);
    }
    return Object.freeze({
      artifactTarget,
      name: manifest.name,
      version: manifest.version,
      tarballPath: file,
      sha256: parsed.gzip.sha256,
      integrity: `sha512-${await sha512Base64(file)}`
    });
  }));
  if (new Set(packages.map((entry) => entry.name)).size !== artifactByName.size) {
    throw new Error("Release publication repeats or omits a package");
  }
  validatePublicationMatrix(packages);
  return Object.freeze({
    manifest: result.manifest,
    packages: Object.freeze(packages)
  });
}

async function run(command: "publish" | "verify", argv: readonly string[]): Promise<void> {
  const [planPath, manifestPath, tarballDirectory] = argv;
  if (argv.length !== 3 || planPath === undefined || manifestPath === undefined
    || tarballDirectory === undefined) {
    throw new Error(
      "usage: npm run release:publish -- <publish|verify>"
      + " <plan.json> <artifact-manifest.json> <tarballs>"
    );
  }
  const npmCli = process.env.npm_execpath;
  const nodeExecutable = process.env.npm_node_execpath;
  if (npmCli === undefined || nodeExecutable === undefined) {
    throw new Error("Run release publication through npm so its tool paths are explicit");
  }
  const sourceRef = process.env.GITHUB_REF;
  const sourceSha = process.env.GITHUB_SHA;
  if (sourceRef === undefined || sourceSha === undefined) {
    throw new Error("Release publication requires the GitHub source ref and commit");
  }
  const authority = githubPublicationAuthority(command, process.env);
  const publication = await publicationPackages(
    planPath,
    manifestPath,
    tarballDirectory
  );
  if (sourceSha !== publication.manifest.sourceCommit) {
    throw new Error("GitHub source commit differs from the release artifact manifest");
  }
  if (sourceRef !== `refs/tags/v${publication.manifest.productVersion}`) {
    throw new Error("GitHub source ref is not the release tag for the released version");
  }
  const registry = new NpmReleaseRegistry({
    npm: { npmCli, nodeExecutable },
    sourceCommit: sourceSha,
    sourceRef
  });
  if (authority !== undefined) {
    const ledger = new GitHubNpmPublicationLedger({
      repository: authority.repository,
      sourceCommit: sourceSha,
      token: authority.token
    });
    const writeGuard = {
      assertWritable: async (packageToPublish: NpmPublicationPackage) => {
        await verifyRemoteReleaseTag({
          version: packageToPublish.version,
          sourceCommit: sourceSha,
          environment: process.env
        });
      }
    };
    await publishNpmRelease(publication.packages, registry, ledger, writeGuard);
  } else {
    await registry.waitUntilVerified(publication.packages);
  }
  process.stdout.write(`${canonicalJson({
    schemaVersion: 1,
    command,
    version: publication.manifest.productVersion,
    packages: publication.packages.map((entry) => ({
      artifactTarget: entry.artifactTarget,
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256
    }))
  })}\n`);
}

function boundedDirectory(value: string): string {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Release tarball directory must be a real directory");
  }
  return realpathSync(resolved);
}

function boundedFile(value: string, maximumBytes: number, label: string): string {
  const resolved = path.resolve(value);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return realpathSync(resolved);
}

function boundedTextFile(value: string, maximumBytes: number, label: string): string {
  const file = boundedFile(value, maximumBytes, label);
  const bytes = readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
}

async function sha512Base64(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

function publishedTarget(value: string): PublishedArtifactTarget {
  const target = PUBLISHED_ARTIFACT_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) throw new Error(`Release tarball targets held package ${value}`);
  return target;
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (command !== "publish" && command !== "verify") {
      throw new Error(
        "usage: npm run release:publish -- <publish|verify>"
        + " <plan.json> <artifact-manifest.json> <tarballs>"
      );
    }
    await run(command, argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-publish: ${message}\n`);
    process.exitCode = 1;
  }
}
