import { isSemVer } from "./semver.js";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

/**
 * Accepts only the real npm registry tarball URL for one exact scoped package
 * and version. npm serves:
 *   https://registry.npmjs.org/@1667-ai/darwin-arm64/-/darwin-arm64-0.1.1.tgz
 * Encoded-path variants, query strings, fragments, credentials, and non-HTTPS
 * origins are rejected.
 */
export function assertCanonicalNpmTarballUrl(
  value: string,
  packageName: string,
  version: string
): string {
  if (!isSemVer(version)) throw new Error("npm tarball version is not SemVer");
  if (!packageName.startsWith("@") || !packageName.includes("/")) {
    throw new Error("npm tarball package must be a scoped name");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("npm tarball URL is invalid");
  }
  if (url.protocol !== "https:"
    || url.origin !== NPM_REGISTRY_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("npm tarball URL is invalid");
  }
  // Reject percent-encoded package segments such as /@scope%2fname/.
  if (url.pathname.includes("%")) {
    throw new Error("npm tarball URL must not use percent-encoded path segments");
  }
  const slash = packageName.indexOf("/");
  const scope = packageName.slice(0, slash);
  const baseName = packageName.slice(slash + 1);
  if (scope.length === 0 || baseName.length === 0 || baseName.includes("/")) {
    throw new Error("npm tarball package name is invalid");
  }
  // Real npm pathname keeps the slash in the scope segment.
  const expectedPath = `/${scope}/${baseName}/-/${baseName}-${version}.tgz`;
  if (url.pathname !== expectedPath) {
    throw new Error("npm tarball URL does not match the package version");
  }
  return value;
}

export function canonicalNpmTarballUrl(packageName: string, version: string): string {
  if (!isSemVer(version)) throw new Error("npm tarball version is not SemVer");
  if (!packageName.startsWith("@") || !packageName.includes("/")) {
    throw new Error("npm tarball package must be a scoped name");
  }
  const slash = packageName.indexOf("/");
  const scope = packageName.slice(0, slash);
  const baseName = packageName.slice(slash + 1);
  const url = `${NPM_REGISTRY_ORIGIN}/${scope}/${baseName}/-/${baseName}-${version}.tgz`;
  return assertCanonicalNpmTarballUrl(url, packageName, version);
}
