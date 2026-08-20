/**
 * Canonical release package layout facts shared by release tooling and the
 * managed upgrade path. Keep digests identical to scripts/release-package-manifests.
 */
export const RELEASE_PACKAGE_REPOSITORY = Object.freeze({
  type: "git" as const,
  url: "git+https://github.com/1667-ai/1667.git" as const
});

export const RELEASE_LICENSE = "Apache-2.0" as const;
export const RELEASE_LICENSE_FILES = Object.freeze(["LICENSE", "NOTICE"] as const);

/**
 * The npm package NOTICE stays byte-compatible with the 0.9.9 updater. Put
 * current third-party attribution in each package's SPDX document instead.
 */
export const RELEASE_PACKAGE_NOTICE = `1667
Copyright 2026 1667.ai

This product includes software developed by 1667.ai.
` as const;

export const RELEASE_LICENSE_FILE_DIGESTS = Object.freeze({
  LICENSE: Object.freeze({
    sha256: "08385ddcf8c5a400d0ace792e968a466e2eadc62d91c4b19a4af71d91f815ef0",
    bytes: 11327
  }),
  NOTICE: Object.freeze({
    sha256: "6f6dd5020bb5bee2e1bbb5b2c6051deb9b369f66818736409b3740fdec52213c",
    bytes: 1352
  })
});

/** Digests required in npm packages, including the 0.9.9-compatible NOTICE. */
export const RELEASE_PACKAGE_LICENSE_FILE_DIGESTS = Object.freeze({
  LICENSE: RELEASE_LICENSE_FILE_DIGESTS.LICENSE,
  NOTICE: Object.freeze({
    sha256: "ef2779740dd724bc6b83cf89485ac684c4e7fe6622752ffd0b65933fef68b6bd",
    bytes: 82
  })
});

export const MAX_RELEASE_SBOM_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_LAUNCHER_BYTES = 128 * 1024;

export type TarballEntry = Readonly<{
  path: string;
  type: "file" | "directory";
  mode: number;
  size: number;
  sha256: string | null;
}>;
