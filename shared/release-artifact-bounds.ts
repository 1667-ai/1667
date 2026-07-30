/**
 * Shared size bounds and transfer time policy for release archives and npm
 * platform packages. Shell Installer and managed upgrade use these exact limits.
 */
export const MAX_RELEASE_ARTIFACT_GZIP_BYTES = 320 * 1024 * 1024;
export const MAX_RELEASE_ARTIFACT_TAR_BYTES = 288 * 1024 * 1024;
export const MAX_RELEASE_ARTIFACT_ENTRIES = 16;
export const MAX_RELEASE_EXECUTABLE_BYTES = 256 * 1024 * 1024;
export const MAX_RELEASE_TOTAL_FILE_BYTES =
  MAX_RELEASE_EXECUTABLE_BYTES + 16 * 1024 * 1024;
export const MAX_RELEASE_MANIFEST_BYTES = 64 * 1024;
export const NPM_METADATA_MAX_BYTES = 64 * 1024;

/** curl --connect-timeout for Shell Installer (seconds, portable curl). */
export const RELEASE_TRANSFER_CONNECT_TIMEOUT_MS = 30_000;
/**
 * Cumulative wall-clock deadline for one release transfer: headers plus the
 * complete body. Shell Installer curl --max-time and managed package download
 * share this bound (600 seconds).
 */
export const RELEASE_TRANSFER_TOTAL_TIMEOUT_MS = 600_000;
/**
 * Managed upgrade body-idle bound between response chunks. Independent of the
 * cumulative wall timeout. Shell Installer has no separate idle timer (curl
 * --max-time is the only transfer deadline there).
 */
export const RELEASE_TRANSFER_BODY_IDLE_TIMEOUT_MS = 60_000;
