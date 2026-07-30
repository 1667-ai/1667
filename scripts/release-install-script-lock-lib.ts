/**
 * Install-root advisory lock helpers for the Shell Installer.
 * BSD flock(2) via lockf(1) on Darwin and util-linux flock(1) on Linux.
 * Same persistent regular-file inode as managed upgrade (openExclusiveLockFile + lockFile).
 */
export const SHELL_INSTALLER_LOCK = `
# Advisory lock on a persistent regular file at \$LOCK_FILE.
# Open on fixed FD 9; keep open through mutation; release by closing FD.
# Never unlink the lock file. Kernel releases on process exit/crash.
# close_install_lock_fd only closes FD 9 — do not redirect stderr with exec
# (that would silence later die messages for the rest of the process).
INSTALL_LOCK_FD=9

close_install_lock_fd() {
  exec 9>&- || true
}

acquire_lock() {
  root=\$1
  lock="\$root/\$LOCK_FILE"
  if [ -L "\$lock" ]; then
    die "Install lock path is a symbolic link"
  fi
  if [ -e "\$lock" ] && [ ! -f "\$lock" ]; then
    die "Install lock path is not a regular file"
  fi
  # Append/create preserves an existing inode; do not truncate or replace.
  # shellcheck disable=SC2094,SC3023
  exec 9>>"\$lock" || die "Could not open the Install Root lock"
  if [ -L "\$lock" ] || [ ! -f "\$lock" ]; then
    close_install_lock_fd
    die "Install lock path is not a regular file"
  fi
  # uname runs in a command-substitution subshell that inherits FD 9.
  # Close it there so a hung uname cannot pin the Install Root lock.
  case "\$(
    exec 9>&-
    uname -s
  )" in
    Darwin)
      if ! command -v lockf >/dev/null 2>&1; then
        close_install_lock_fd
        die "lockf is required to acquire the Install Root lock"
      fi
      if ! lockf -s -t 0 9; then
        close_install_lock_fd
        die "Another install holds the Install Root lock"
      fi
      ;;
    Linux)
      if ! command -v flock >/dev/null 2>&1; then
        close_install_lock_fd
        die "flock is required to acquire the Install Root lock"
      fi
      if ! flock -n 9; then
        close_install_lock_fd
        die "Another install holds the Install Root lock"
      fi
      ;;
    *)
      close_install_lock_fd
      die "Install Root lock is supported only on Darwin and Linux"
      ;;
  esac
}

release_lock() {
  # Idempotent. Close FD 9; optional Linux unlock before close.
  # uname subshell inherits FD 9 while the lock is still held; close it there.
  case "\$(
    exec 9>&-
    uname -s
  )" in
    Linux)
      if command -v flock >/dev/null 2>&1; then
        flock -u 9 2>/dev/null || true
      fi
      ;;
  esac
  close_install_lock_fd
}
`;
