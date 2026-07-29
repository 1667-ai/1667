const HTTP_DATA_DIRECTORY_ID = /^[0-9a-f]{64}$/;

export function isHttpDataDirectoryId(
  value: unknown
): value is string {
  return typeof value === "string" && HTTP_DATA_DIRECTORY_ID.test(value);
}
