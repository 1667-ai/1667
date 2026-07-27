import {
  RELEASE_LAUNCHER_PACKAGE,
  RELEASE_PLATFORM_PACKAGES,
  registryPathForPackage,
  releaseTargetForArtifact,
  releaseTargetForPackage,
  type PackagedArtifactTarget
} from "../shared/release-targets.js";
import {
  RELEASE_LICENSE,
  RELEASE_PACKAGE_REPOSITORY
} from "./release-package-manifests.js";
import type { ReleaseIdentitySet } from "./release-identity.js";
import {
  compareStrings,
  npmPurl,
  registryTarballUrl,
  RELEASE_BUN_RUNTIME,
  type ReleaseBundledComponent
} from "./release-sbom-components.js";

export type SpdxRelationshipType =
  | "DESCRIBES"
  | "CONTAINS"
  | "DEPENDS_ON"
  | "OPTIONAL_DEPENDENCY_OF";

export interface SpdxChecksum {
  readonly algorithm: "SHA512";
  readonly checksumValue: string;
}

export interface SpdxExternalRef {
  readonly referenceCategory: "PACKAGE-MANAGER";
  readonly referenceType: "purl";
  readonly referenceLocator: string;
}

export interface SpdxPackage {
  readonly SPDXID: string;
  readonly name: string;
  readonly versionInfo: string;
  readonly downloadLocation: string;
  readonly filesAnalyzed: false;
  readonly licenseConcluded: string;
  readonly licenseDeclared: string;
  readonly copyrightText: string;
  readonly supplier: string;
  readonly primaryPackagePurpose: "APPLICATION" | "LIBRARY";
  readonly comment: string;
  readonly checksums?: readonly SpdxChecksum[];
  readonly externalRefs?: readonly SpdxExternalRef[];
  readonly packageFileName?: string;
  readonly sourceInfo?: string;
  readonly builtDate?: string;
}

export interface SpdxRelationship {
  readonly spdxElementId: string;
  readonly relationshipType: SpdxRelationshipType;
  readonly relatedSpdxElement: string;
}

export interface SpdxCreationInfo {
  readonly created: string;
  readonly creators: readonly string[];
}

export interface SpdxDocument {
  readonly spdxVersion: "SPDX-2.3";
  readonly dataLicense: "CC0-1.0";
  readonly SPDXID: "SPDXRef-DOCUMENT";
  readonly name: string;
  readonly documentNamespace: string;
  readonly comment: string;
  readonly creationInfo: SpdxCreationInfo;
  readonly documentDescribes: readonly string[];
  readonly packages: readonly SpdxPackage[];
  readonly relationships: readonly SpdxRelationship[];
}

export const RELEASE_SBOM_GENERATOR = "1667-release-sbom-1" as const;
const PRODUCT_NAME = "1667" as const;
const PRODUCT_SUPPLIER = "Organization: 1667" as const;
const DOCUMENT_ID = "SPDXRef-DOCUMENT" as const;

/**
 * A `.invalid` host, matching the convention the generated JSON Schemas use:
 * an SPDX document namespace is an identifier that nothing should dereference,
 * and pointing it at a real host would invite exactly that.
 */
const NAMESPACE_ROOT = "https://1667.invalid/spdx" as const;

/**
 * The launcher package. It ships one dependency-free Node.js file, embeds no
 * runtime, and bundles no third-party code, so the document says that rather
 * than repeating a platform package's inventory. What it does carry is the
 * exact-version pin on all four platform packages, which is the only thing an
 * installation of the launcher actually pulls in.
 */
export function launcherSbomDocument(identities: ReleaseIdentitySet): SpdxDocument {
  const version = identities.evidence.productVersion;
  const product = productPackage(identities, {
    packageFileName: "bin/1667.js",
    sourceInfo: `Launcher published as ${RELEASE_LAUNCHER_PACKAGE}, built from `
      + `${RELEASE_PACKAGE_REPOSITORY.url} at commit ${identities.evidence.sourceCommit}. `
      + "Plain JavaScript executed by the host Node.js; no runtime is embedded and "
      + "no third-party code is bundled.",
    publishedAs: RELEASE_LAUNCHER_PACKAGE
  });
  const platforms = RELEASE_PLATFORM_PACKAGES.map((packageName) => {
    return platformDependencyPackage(packageName, version);
  });
  const relationships = [
    describes(product.SPDXID),
    ...platforms.map((entry) => {
      return relationship(entry.SPDXID, "OPTIONAL_DEPENDENCY_OF", product.SPDXID);
    })
  ];
  return document({
    identities,
    packageName: RELEASE_LAUNCHER_PACKAGE,
    comment: "Bill of materials for the 1667 launcher package. The launcher embeds no "
      + "language runtime and bundles no third-party code; it selects and executes the "
      + "platform package pinned at the same exact version.",
    product,
    packages: [product, ...platforms],
    relationships
  });
}

/**
 * A platform package. Its single executable is a Bun-compiled binary, so the
 * embedded runtime and every bundled dependency are inside the shipped bytes
 * and are reported as `CONTAINS`, alongside the dependency edges that put them
 * there.
 */
export function platformSbomDocument(
  identities: ReleaseIdentitySet,
  target: PackagedArtifactTarget,
  components: readonly ReleaseBundledComponent[]
): SpdxDocument {
  const descriptor = releaseTargetForArtifact(target);
  if (components.length === 0) {
    throw new Error(`Release SBOM for ${descriptor.packageName} would list no components`);
  }
  const product = productPackage(identities, {
    packageFileName: descriptor.executable,
    sourceInfo: `Published as ${descriptor.packageName} for ${descriptor.platform}/`
      + `${descriptor.arch}${descriptor.libc === null ? "" : ` (${descriptor.libc})`}. `
      + `Compiled from ${RELEASE_PACKAGE_REPOSITORY.url} at commit `
      + `${identities.evidence.sourceCommit} into a single executable that embeds the `
      + `Bun ${RELEASE_BUN_RUNTIME.version} runtime.`,
    publishedAs: descriptor.packageName
  });
  const runtime = runtimePackage();
  const bundled = components.map((component) => {
    return { component, entry: bundledPackage(component) };
  });
  const relationships = [
    describes(product.SPDXID),
    relationship(product.SPDXID, "CONTAINS", runtime.SPDXID),
    relationship(product.SPDXID, "DEPENDS_ON", runtime.SPDXID),
    ...bundled.flatMap(({ component, entry }) => {
      // The inventory resolves `requiredBy` against itself, so the parent is a
      // component of this same document and its identifier is a pure function
      // of the name and version it carries. Nothing to look up, nothing to fail.
      const parent = component.requiredBy === null
        ? product.SPDXID
        : spdxPackageId(component.requiredBy.name, component.requiredBy.version);
      return [
        relationship(product.SPDXID, "CONTAINS", entry.SPDXID),
        relationship(parent, "DEPENDS_ON", entry.SPDXID)
      ];
    })
  ];
  return document({
    identities,
    packageName: descriptor.packageName,
    comment: `Bill of materials for the 1667 ${target} package. Its executable is a `
      + "Bun-compiled binary, so the runtime and every bundled dependency listed here "
      + "are contained in the shipped bytes.",
    product,
    packages: [product, runtime, ...bundled.map(({ entry }) => entry)],
    relationships
  });
}

/**
 * SPDX 2.3 fixes creation dates at second precision, so the release build
 * timestamp is truncated rather than replaced. No other time source is read.
 */
export function spdxTimestamp(buildTimestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/u.exec(buildTimestamp);
  const seconds = match?.[1];
  if (seconds === undefined) {
    throw new Error("Release build timestamp is not a canonical UTC instant");
  }
  return `${seconds}Z`;
}

export function spdxPackageId(name: string, version: string): string {
  const slug = `${name}-${version}`
    .replaceAll(/[^A-Za-z0-9.]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  if (slug.length === 0) throw new Error(`Release SBOM cannot identify ${name}`);
  return `SPDXRef-Package-${slug}`;
}

interface DocumentInput {
  readonly identities: ReleaseIdentitySet;
  readonly packageName: string;
  readonly comment: string;
  readonly product: SpdxPackage;
  readonly packages: readonly SpdxPackage[];
  readonly relationships: readonly SpdxRelationship[];
}

function document(input: DocumentInput): SpdxDocument {
  const version = input.identities.evidence.productVersion;
  const packages = [...input.packages].sort((left, right) => {
    return compareStrings(left.SPDXID, right.SPDXID);
  });
  const identifiers = new Set(packages.map((entry) => entry.SPDXID));
  if (identifiers.size !== packages.length) {
    throw new Error(`Release SBOM for ${input.packageName} repeats an SPDX identifier`);
  }
  if (!identifiers.has(input.product.SPDXID)) {
    throw new Error(`Release SBOM for ${input.packageName} omits the product it describes`);
  }
  const relationships = [...input.relationships].sort(compareRelationships);
  for (const entry of relationships) {
    const known = (identifier: string): boolean => {
      return identifier === DOCUMENT_ID || identifiers.has(identifier);
    };
    if (!known(entry.spdxElementId) || !known(entry.relatedSpdxElement)) {
      throw new Error(`Release SBOM for ${input.packageName} relates an unlisted element`);
    }
  }
  return Object.freeze({
    spdxVersion: "SPDX-2.3" as const,
    dataLicense: "CC0-1.0" as const,
    SPDXID: DOCUMENT_ID,
    name: `${input.packageName}@${version}`,
    documentNamespace: `${NAMESPACE_ROOT}/${registryPathForPackage(input.packageName)}/${version}`
      + `/${input.identities.evidence.sourceCommit}`,
    comment: input.comment,
    creationInfo: Object.freeze({
      created: spdxTimestamp(input.identities.evidence.buildTimestamp),
      creators: Object.freeze([PRODUCT_SUPPLIER, `Tool: ${RELEASE_SBOM_GENERATOR}`])
    }),
    documentDescribes: Object.freeze([input.product.SPDXID]),
    packages: Object.freeze(packages),
    relationships: Object.freeze(relationships)
  });
}

function productPackage(
  identities: ReleaseIdentitySet,
  detail: {
    readonly packageFileName: string;
    readonly sourceInfo: string;
    readonly publishedAs: string;
  }
): SpdxPackage {
  const version = identities.evidence.productVersion;
  return Object.freeze({
    SPDXID: spdxPackageId(PRODUCT_NAME, version),
    name: PRODUCT_NAME,
    versionInfo: version,
    // SPDX 2.3 VCS locations are `<vcs>+<transport>://<host>/<path>[@<revision>]
    // [#<sub_path>]`: `@` introduces the revision, while `#` introduces a path
    // inside the checkout. The commit belongs in the revision slot.
    downloadLocation: `${RELEASE_PACKAGE_REPOSITORY.url}@${identities.evidence.sourceCommit}`,
    filesAnalyzed: false as const,
    licenseConcluded: RELEASE_LICENSE,
    licenseDeclared: RELEASE_LICENSE,
    copyrightText: "NOASSERTION",
    supplier: PRODUCT_SUPPLIER,
    primaryPackagePurpose: "APPLICATION" as const,
    comment: `Built from tag ${identities.evidence.tagName} at a clean working tree.`,
    packageFileName: detail.packageFileName,
    sourceInfo: detail.sourceInfo,
    builtDate: spdxTimestamp(identities.evidence.buildTimestamp),
    // Every dependency below carries a purl, so without one here the document
    // describes a product no scanner can match back to the registry it ships
    // from. externalRefs is the only machine-readable identifier SPDX offers.
    externalRefs: Object.freeze([externalRef(npmPurl(detail.publishedAs, version))])
  });
}

function runtimePackage(): SpdxPackage {
  return Object.freeze({
    SPDXID: spdxPackageId(RELEASE_BUN_RUNTIME.name, RELEASE_BUN_RUNTIME.version),
    name: RELEASE_BUN_RUNTIME.name,
    versionInfo: RELEASE_BUN_RUNTIME.version,
    downloadLocation: RELEASE_BUN_RUNTIME.downloadLocation,
    filesAnalyzed: false as const,
    licenseConcluded: RELEASE_BUN_RUNTIME.license,
    licenseDeclared: RELEASE_BUN_RUNTIME.license,
    copyrightText: "NOASSERTION",
    supplier: "Organization: Oven",
    primaryPackagePurpose: "APPLICATION" as const,
    comment: "Language runtime embedded in the executable by the compiling toolchain. "
      + "No digest is asserted: the release build embeds the runtime it was compiled "
      + "with rather than a separately downloaded artifact.",
    externalRefs: Object.freeze([externalRef(RELEASE_BUN_RUNTIME.purl)])
  });
}

function bundledPackage(component: ReleaseBundledComponent): SpdxPackage {
  return Object.freeze({
    SPDXID: spdxPackageId(component.name, component.version),
    name: component.name,
    versionInfo: component.version,
    downloadLocation: component.downloadLocation,
    filesAnalyzed: false as const,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    copyrightText: "NOASSERTION",
    supplier: "NOASSERTION",
    primaryPackagePurpose: "LIBRARY" as const,
    comment: "Bundled into the executable at build time.",
    checksums: Object.freeze([Object.freeze({
      algorithm: "SHA512" as const,
      checksumValue: component.sha512
    })]),
    externalRefs: Object.freeze([externalRef(component.purl)])
  });
}

function platformDependencyPackage(packageName: string, version: string): SpdxPackage {
  const descriptor = releaseTargetForPackage(packageName);
  if (descriptor === null) throw new Error(`Release SBOM has no descriptor for ${packageName}`);
  return Object.freeze({
    SPDXID: spdxPackageId(packageName, version),
    name: packageName,
    versionInfo: version,
    downloadLocation: registryTarballUrl(packageName, version),
    filesAnalyzed: false as const,
    licenseConcluded: RELEASE_LICENSE,
    licenseDeclared: RELEASE_LICENSE,
    copyrightText: "NOASSERTION",
    supplier: PRODUCT_SUPPLIER,
    primaryPackagePurpose: "APPLICATION" as const,
    comment: `Exact-version pin selected on ${descriptor.platform}/${descriptor.arch}`
      + `${descriptor.libc === null ? "" : ` (${descriptor.libc})`}. Its own document `
      + "lists the runtime and dependencies it embeds; no digest is asserted here "
      + "because the tarball is packed after this document.",
    externalRefs: Object.freeze([externalRef(npmPurl(packageName, version))])
  });
}

function externalRef(locator: string): SpdxExternalRef {
  return Object.freeze({
    referenceCategory: "PACKAGE-MANAGER" as const,
    referenceType: "purl" as const,
    referenceLocator: locator
  });
}

function describes(target: string): SpdxRelationship {
  return relationship(DOCUMENT_ID, "DESCRIBES", target);
}

function relationship(
  spdxElementId: string,
  relationshipType: SpdxRelationshipType,
  relatedSpdxElement: string
): SpdxRelationship {
  return Object.freeze({ spdxElementId, relationshipType, relatedSpdxElement });
}

function compareRelationships(left: SpdxRelationship, right: SpdxRelationship): number {
  return compareStrings(left.spdxElementId, right.spdxElementId)
    || compareStrings(left.relationshipType, right.relationshipType)
    || compareStrings(left.relatedSpdxElement, right.relatedSpdxElement);
}
