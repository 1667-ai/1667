import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";
import { ServiceError } from "./errors.js";

const ACL_TYPE_EXTENDED = 0x100;
const ACL_FIRST_ENTRY = 0;
const ACL_NEXT_ENTRY = 1;
const ACL_EXTENDED_DENY = 2;
const DARWIN_ENOENT = 2;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number"
  ? constants.O_NOFOLLOW
  : 0;

/**
 * Packaged Darwin privacy proof for the machine tier. Safe deny entries are
 * permitted; any extended allow (or unknown tag) is rejected instead of
 * interpreting a principal/permission combination too loosely.
 *
 * ADR007 removed this scan from the project tier, which is user data in a
 * user-chosen folder. It stays on the machine tier because that directory holds
 * provider keys, and POSIX mode 0700 does not revoke an inherited macOS ACL —
 * an ACE on `~/Library/Application Support` would otherwise be inherited by the
 * state directory 1667 creates inside it.
 */
export async function assertNoDarwinExtendedAllow(
  target: string,
  label: string
): Promise<void> {
  if (process.platform !== "darwin" || process.versions.bun === undefined) {
    return;
  }
  const ffi = await loadBunFfi();
  const libc = openPosixLibc(ffi, {
    acl_get_fd_np: { args: ["i32", "i32"], returns: "ptr" },
    acl_get_entry: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    acl_get_tag_type: { args: ["ptr", "ptr"], returns: "i32" },
    acl_free: { args: ["ptr"], returns: "i32" },
    __error: { args: [], returns: "ptr" }
  });
  const entry = Buffer.alloc(8);
  const tag = Buffer.alloc(4);
  let acl: number | bigint = 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | NOFOLLOW_FLAG
    );
    acl = libc.symbols.acl_get_fd_np!(
      handle.fd,
      ACL_TYPE_EXTENDED
    );
    if (Number(acl) === 0) {
      // Darwin reports ENOENT when a valid open file has no extended ACL.
      // The descriptor makes this distinct from a missing or replaced path.
      if (readDarwinErrno(ffi, libc) === DARWIN_ENOENT) return;
      throw privacyError(target, label);
    }
    let selector = ACL_FIRST_ENTRY;
    for (;;) {
      const result = Number(libc.symbols.acl_get_entry!(
        acl,
        selector,
        ffi.ptr(entry)
      ));
      if (result === -1) return;
      if (result !== 0) throw privacyError(target, label);
      selector = ACL_NEXT_ENTRY;
      const entryPointer = Number(entry.readBigUInt64LE());
      if (entryPointer === 0
        || Number(libc.symbols.acl_get_tag_type!(
          entryPointer,
          ffi.ptr(tag)
        )) !== 0) {
        throw privacyError(target, label);
      }
      const tagType = tag.readInt32LE();
      if (tagType !== ACL_EXTENDED_DENY) {
        throw privacyError(target, label);
      }
    }
  } finally {
    if (Number(acl) !== 0) libc.symbols.acl_free!(acl);
    await handle?.close();
    entry.fill(0);
    tag.fill(0);
    libc.close();
  }
}

function readDarwinErrno(
  ffi: Awaited<ReturnType<typeof loadBunFfi>>,
  libc: ReturnType<typeof openPosixLibc>
): number {
  const pointer = Number(libc.symbols.__error!());
  if (pointer === 0) return 0;
  const bytes = ffi.toArrayBuffer(pointer, 0, 4);
  return new DataView(bytes).getInt32(0, true);
}

function privacyError(target: string, label: string): ServiceError {
  return new ServiceError(
    409,
    `1667 ${label} has an unsupported Darwin extended ACL: ${target}`,
    "data_directory_unowned"
  );
}
