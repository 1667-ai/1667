/** Durable fsync helpers embedded in the Shell Installer. */
export const SHELL_INSTALLER_DURABLE = `
# Prefer python3 os.fsync when present; else require successful sync(1).
# Close Install Root lock FD 9 on durable-sync helpers so they cannot pin the lock.
fsync_path() {
  path=\$1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os, sys
path = sys.argv[1]
fd = os.open(path, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
directory = os.path.dirname(path) or "."
dfd = os.open(directory, os.O_RDONLY)
try:
    os.fsync(dfd)
finally:
    os.close(dfd)
' "\$path" 9>&- || die "Could not durable-sync \$path"
    return 0
  fi
  sync 9>&- || die "Could not durable-sync \$path (sync failed; python3 not available)"
}

fsync_dir() {
  directory=\$1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os, sys
directory = sys.argv[1]
dfd = os.open(directory, os.O_RDONLY)
try:
    os.fsync(dfd)
finally:
    os.close(dfd)
' "\$directory" 9>&- || die "Could not durable-sync directory \$directory"
    return 0
  fi
  sync 9>&- || die "Could not durable-sync directory \$directory (sync failed; python3 not available)"
}
`;
