export const MAX_CREDENTIAL_NAMES_PER_DOCUMENT = 32;
export const MAX_CREDENTIAL_NAMES_PER_STATE = 64;

export const CREDENTIAL_ENV_PATTERN_SOURCE =
  "[A-Za-z_][A-Za-z0-9_]{0,63}";
export const CREDENTIAL_ENV_PATTERN = new RegExp(
  `^(?:${CREDENTIAL_ENV_PATTERN_SOURCE})$`,
  "u"
);

const RESERVED_CREDENTIAL_NAMES = new Set([
  "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "TERM", "COLORTERM", "TMUX",
  "LANG", "LANGUAGE", "EDITOR", "VISUAL", "DISPLAY", "WAYLAND_DISPLAY",
  "XAUTHORITY", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SYSTEMROOT",
  "COMSPEC", "PATHEXT", "WINDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "NO_PROXY"
]);
const RESERVED_CREDENTIAL_PREFIXES = [
  "LC_", "XDG_", "NODE_", "BUN_", "LD_", "DYLD_", "NPM_CONFIG_"
] as const;

/** One portable credential-slot policy shared by settings and supervision. */
export function isCredentialEnvironmentName(
  value: unknown,
  caseInsensitive = process.platform === "win32"
): value is string {
  if (typeof value !== "string" || !CREDENTIAL_ENV_PATTERN.test(value)) {
    return false;
  }
  const compared = caseInsensitive ? value.toUpperCase() : value;
  return !RESERVED_CREDENTIAL_NAMES.has(compared)
    && !RESERVED_CREDENTIAL_PREFIXES.some((prefix) =>
      compared.startsWith(prefix));
}
