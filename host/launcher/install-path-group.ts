import { execFileSync } from "node:child_process";

/**
 * Who, other than this user, can write through a group.
 *
 * A group-writable directory is only an exposure when the group holds somebody
 * else. Ubuntu gives each user a private group, and Homebrew's `admin` group
 * holds root and the owner, so a rule that reads the group-write bit alone
 * refuses a directory that no other person can write.
 *
 * `/etc/group` cannot answer this. macOS keeps group membership in Directory
 * Services and lists `admin:*:80:root` in the file, without the account that is
 * really a member, so a reader of that file fails open on macOS. Each platform
 * is asked through the interface that knows the answer.
 */
export interface GroupMembership {
  /** The group name, when the platform resolved one. */
  readonly name: string | null;
  /** Members other than this user and root, sorted. Never null when resolved. */
  readonly others: readonly string[];
}

const LOOKUP_TIMEOUT_MS = 2_000;
const LOOKUP_MAX_BYTES = 64 * 1024;

function run(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], {
      encoding: "utf8",
      timeout: LOOKUP_TIMEOUT_MS,
      maxBuffer: LOOKUP_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
  } catch {
    return null;
  }
}

/** Split a member list that arrives comma-separated or space-separated. */
export function parseMembers(value: string): readonly string[] {
  return value
    .split(/[\s,]+/u)
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

/** `getent group <gid>` prints `name:x:gid:member,member`. */
export function parseGetentGroup(line: string): GroupMembership | null {
  const fields = line.trim().split(":");
  if (fields.length < 4 || fields[0] === undefined) return null;
  return {
    name: fields[0],
    others: parseMembers(fields.slice(3).join(":"))
  };
}

/** `dscl . -read /Groups/<name> GroupMembership` prints one labelled line. */
export function parseDsclMembership(output: string): readonly string[] {
  const marker = "GroupMembership:";
  const at = output.indexOf(marker);
  if (at < 0) return [];
  return parseMembers(output.slice(at + marker.length).split("\n")[0] ?? "");
}

function darwinMembership(gid: number): GroupMembership | null {
  const search = run("/usr/bin/dscl", [".", "-search", "/Groups", "PrimaryGroupID", String(gid)]);
  const name = search?.trim().split(/\s+/u)[0];
  if (name === undefined || name.length === 0) return null;
  const read = run("/usr/bin/dscl", [".", "-read", `/Groups/${name}`, "GroupMembership"]);
  // A group with no members has no GroupMembership key at all, and `dscl` exits
  // nonzero. That is an empty membership, not a failed lookup.
  return { name, others: read === null ? [] : [...parseDsclMembership(read)] };
}

function linuxMembership(gid: number): GroupMembership | null {
  // `getent` answers for every source in nsswitch, including LDAP and SSSD,
  // which a reader of `/etc/group` would miss. Only an absolute path is run, so
  // the answer cannot come from a directory on PATH.
  //
  // A supplementary member list omits an account that holds this group as its
  // primary group. Finding those means reading every account, which is
  // unbounded on a directory-backed host, so this check does not claim to.
  const line = run("/usr/bin/getent", ["group", String(gid)])
    ?? run("/bin/getent", ["group", String(gid)]);
  return line === null ? null : parseGetentGroup(line);
}

/**
 * Members of `gid` other than this user and root, or null when the platform
 * could not answer. Root already holds the authority this check is about, so it
 * is not somebody else.
 */
export function groupOtherMembers(gid: number, user: string): GroupMembership | null {
  const resolved = process.platform === "darwin"
    ? darwinMembership(gid)
    : linuxMembership(gid);
  if (resolved === null) return null;
  const others = resolved.others
    .filter((member) => member !== user && member !== "root")
    .sort();
  return { name: resolved.name, others };
}
