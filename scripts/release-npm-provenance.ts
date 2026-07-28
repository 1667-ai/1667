import { X509Certificate } from "node:crypto";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { type NpmPublicationPackage } from "./release-npm-publisher.js";

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const INTOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const GITHUB_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_BUILDER = "https://github.com/actions/runner/github-hosted";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CERTIFICATE_BYTES = 32 * 1024;

export class NpmRegistryPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NpmRegistryPendingError";
  }
}

export function validateNpmAuditProvenance(
  value: unknown,
  expected: NpmPublicationPackage,
  source: {
    readonly sourceCommit: string;
    readonly sourceRef: string;
    readonly workflowPath: string;
    readonly repositoryUrl: string;
  }
): void {
  const audit = object(value, "npm signature audit");
  const invalid = array(audit.invalid, "npm invalid signatures");
  const missing = array(audit.missing, "npm missing signatures");
  if (invalid.length !== 0) {
    throw new Error("npm signature audit reported invalid evidence");
  }
  if (missing.length !== 0) {
    throw new NpmRegistryPendingError("npm signature audit reported missing evidence");
  }
  const verified = array(audit.verified, "npm verified attestations");
  const record = verified.map((entry) => object(entry, "npm verified package")).find((entry) => {
    return entry.name === expected.name && entry.version === expected.version;
  });
  if (record === undefined) {
    throw new NpmRegistryPendingError(
      `${expected.name}@${expected.version} has no verified npm attestation`
    );
  }
  const bundles = array(record.attestationBundles, "npm attestation bundles");
  const provenance = bundles.map((entry) => object(entry, "npm attestation bundle")).find((entry) => {
    return entry.predicateType === SLSA_PROVENANCE_V1;
  });
  if (provenance === undefined) {
    throw new NpmRegistryPendingError(
      `${expected.name}@${expected.version} has no verified provenance`
    );
  }
  const bundle = object(provenance.bundle, "npm provenance bundle");
  const verificationMaterial = object(
    bundle.verificationMaterial,
    "npm provenance verification material"
  );
  const certificate = object(
    verificationMaterial.certificate,
    "npm provenance certificate"
  );
  validateWorkflowCertificate(certificate.rawBytes, source);
  const envelope = object(bundle.dsseEnvelope, "npm provenance envelope");
  const statement = object(
    parseJsonRejectingDuplicateKeys(decodeBase64String(envelope.payload, "npm provenance payload")),
    "npm provenance statement"
  );
  if (statement._type !== INTOTO_STATEMENT_V1
    || statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error("npm provenance has an unsupported statement type");
  }
  const subjects = array(statement.subject, "npm provenance subjects");
  if (subjects.length !== 1) throw new Error("npm provenance must name one package subject");
  const subject = object(subjects[0], "npm provenance package subject");
  const subjectDigest = object(subject.digest, "npm provenance package digest");
  if (subject.name !== npmPackageUrl(expected)
    || subjectDigest.sha512 !== integritySha512(expected.integrity)) {
    throw new Error("npm provenance names the wrong package bytes");
  }
  const predicate = object(statement.predicate, "npm provenance predicate");
  const buildDefinition = object(predicate.buildDefinition, "npm provenance build definition");
  if (buildDefinition.buildType !== GITHUB_BUILD_TYPE) {
    throw new Error("npm provenance has an unexpected build type");
  }
  const external = object(
    buildDefinition.externalParameters,
    "npm provenance external parameters"
  );
  const workflow = object(external.workflow, "npm provenance workflow");
  if (workflow.path !== source.workflowPath
    || workflow.repository !== source.repositoryUrl
    || workflow.ref !== source.sourceRef) {
    throw new Error("npm provenance names the wrong workflow");
  }
  const dependencies = array(
    buildDefinition.resolvedDependencies,
    "npm provenance dependencies"
  );
  if (dependencies.length !== 1) {
    throw new Error("npm provenance must name one source dependency");
  }
  const dependency = object(dependencies[0], "npm provenance source dependency");
  const digest = object(dependency.digest, "npm provenance source digest");
  if (dependency.uri !== `git+${source.repositoryUrl}@${source.sourceRef}`
    || digest.gitCommit !== source.sourceCommit) {
    throw new Error("npm provenance names the wrong source commit");
  }
  const runDetails = object(predicate.runDetails, "npm provenance run details");
  const builder = object(runDetails.builder, "npm provenance builder");
  if (builder.id !== GITHUB_BUILDER) {
    throw new Error("npm provenance was not built on a GitHub-hosted runner");
  }
}

function npmPackageUrl(expected: NpmPublicationPackage): string {
  const slash = expected.name.indexOf("/");
  const name = slash === -1
    ? expected.name
    : `${encodeURIComponent(expected.name.slice(0, slash))}/${expected.name.slice(slash + 1)}`;
  return `pkg:npm/${name}@${expected.version}`;
}

function integritySha512(value: string): string {
  if (!value.startsWith("sha512-")) throw new Error("npm package integrity is not SHA-512");
  const base64 = value.slice("sha512-".length);
  if (!BASE64.test(base64)) throw new Error("npm package integrity is not canonical base64");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== 64 || bytes.toString("base64") !== base64) {
    throw new Error("npm package integrity is not a SHA-512 digest");
  }
  return bytes.toString("hex");
}

function validateWorkflowCertificate(
  value: unknown,
  source: {
    readonly sourceRef: string;
    readonly workflowPath: string;
    readonly repositoryUrl: string;
  }
): void {
  const bytes = decodeBase64Bytes(value, "npm provenance certificate");
  if (bytes.byteLength > MAX_CERTIFICATE_BYTES) {
    throw new Error("npm provenance certificate is too large");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(bytes);
  } catch (error) {
    throw new Error("npm provenance certificate is not valid DER", { cause: error });
  }
  const expectedIdentity =
    `URI:${source.repositoryUrl}/${source.workflowPath}@${source.sourceRef}`;
  if (certificate.subjectAltName !== expectedIdentity) {
    throw new Error("npm provenance has the wrong signing certificate identity");
  }
}

function decodeBase64String(value: unknown, label: string): string {
  const bytes = decodeBase64Bytes(value, label);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
}

function decodeBase64Bytes(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
