/** Shared shell helper functions embedded in the Shell Installer. */
export const SHELL_INSTALLER_HELPERS = `
detect_target() {
  os=\$(uname -s)
  arch=\$(uname -m)
  case "\$os" in
    Darwin)
      case "\$arch" in
        arm64) printf 'darwin-arm64\\n' ;;
        x86_64) printf 'darwin-x64\\n' ;;
        *) die "Unsupported macOS architecture: \$arch" ;;
      esac
      ;;
    Linux)
      if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ] \\
        || [ -e /lib/libc.musl-x86_64.so.1 ] || [ -e /lib/libc.musl-aarch64.so.1 ]; then
        die "Linux systems that use musl are not supported"
      fi
      case "\$arch" in
        aarch64|arm64) printf 'linux-arm64\\n' ;;
        x86_64|amd64) printf 'linux-x64\\n' ;;
        *) die "Unsupported Linux architecture: \$arch" ;;
      esac
      ;;
    *)
      die "Unsupported operating system: \$os"
      ;;
  esac
}

# Paths are written into JSON without escaping. Reject quote, backslash, and
# control characters before any Install Root mutation.
assert_json_safe_path() {
  value=\$1
  label=\$2
  case \$value in
    *\\"*)
      die "\$label must not contain a quote or backslash"
      ;;
  esac
  case \$value in
    *\\\\*)
      die "\$label must not contain a quote or backslash"
      ;;
  esac
  # Keep only printable ASCII (space through tilde). Any control or non-ASCII fails.
  cleaned=\$(printf '%s' "\$value" | tr -cd '\\40-\\176')
  if [ "\$cleaned" != "\$value" ]; then
    die "\$label must not contain a control character"
  fi
}

# Members of a group other than this user and root. Sets GROUP_NAME and
# GROUP_OTHERS. Returns 1 when the platform cannot answer, which is not the same
# as a group with nobody else in it.
#
# /etc/group cannot answer on macOS: it lists 'admin:*:80:root' while Directory
# Services holds the account that is really a member, so a reader of that file
# says a shared group is private. Each platform is asked through the interface
# that knows.
group_other_members() {
  gid=\$1
  me=\$2
  GROUP_NAME=
  GROUP_OTHERS=
  members=
  if [ -x /usr/bin/getent ] || [ -x /bin/getent ]; then
    getent_bin=/usr/bin/getent
    [ -x "\$getent_bin" ] || getent_bin=/bin/getent
    line=\$(exec 9>&-; "\$getent_bin" group "\$gid" 2>/dev/null) || return 1
    [ -n "\$line" ] || return 1
    GROUP_NAME=\${line%%:*}
    members=\${line##*:}
  elif [ -x /usr/bin/dscl ]; then
    GROUP_NAME=\$(exec 9>&-; /usr/bin/dscl . -search /Groups PrimaryGroupID "\$gid" 2>/dev/null \\
      | awk 'NR==1{print \$1}') || return 1
    [ -n "\$GROUP_NAME" ] || return 1
    # A group with nobody in it has no GroupMembership key, and dscl exits
    # nonzero. That is an empty membership, not a failed lookup.
    members=\$(exec 9>&-; /usr/bin/dscl . -read "/Groups/\$GROUP_NAME" GroupMembership 2>/dev/null \\
      | sed -n 's/^GroupMembership: //p') || members=
  else
    return 1
  fi
  GROUP_OTHERS=\$(exec 9>&-; printf '%s' "\$members" | tr ', ' '\\n\\n' \\
    | grep -v -e '^\$' -e "^root\\\$" -e "^\$me\\\$" | tr '\\n' ' ' || true)
  GROUP_OTHERS=\${GROUP_OTHERS% }
  return 0
}

# The Install Root must be a name this Installer can write into the Ownership
# Record, a directory this user owns, and a directory no other account can
# write. 1667 stages a candidate here, checks its digest, runs it once, and then
# renames it into place; an account that can write here can replace the
# candidate inside that window.
#
# Writable to everybody always fails. Writable to a group fails only when the
# group holds somebody else, because Ubuntu gives each user a private group and
# Homebrew's admin group holds root and the owner. Reading the bit alone refused
# those layouts and named no exposure.

# Refuse, or warn and continue when the caller passed --force. A waived refusal
# still prints, so the reader who forced it can read what they accepted.
refuse_root() {
  forced=\$1
  message=\$2
  if [ "\$forced" -eq 1 ]; then
    printf 'warning: %s\\n' "\$message" >&2
    printf 'warning: --force accepted this Install Root anyway.\\n' >&2
    return 0
  fi
  die "\$message"
}

validate_install_root() {
  root=\$1
  forced=\${2:-0}
  assert_json_safe_path "\$root" "Install Root"
  if [ -e "\$root" ]; then
    if [ ! -d "\$root" ]; then
      die "Install Root is not a directory: \$root"
    fi
    owner=\$(owner_uid "\$root") || return 1
    me=\$(id -u)
    if [ "\$owner" != "\$me" ]; then
      refuse_root "\$forced" "Install Root \$root belongs to user \$owner, and you are \$(id -un). 1667 replaces files there during an upgrade, which it cannot do as another user. Run: sudo chown \$(id -un) \$root, choose another Install Root, or pass --force to install here anyway."
    fi
    mode=\$(file_mode "\$root") || return 1
    if [ \$(( \$(printf '%d' "0\$mode") & 2 )) -ne 0 ]; then
      refuse_root "\$forced" "Install Root \$root is writable by every account on this machine (mode \$mode). Any of them could replace what 1667 installs there. Run: chmod o-w \$root - or pass --force to install here anyway."
    fi
    if [ \$(( \$(printf '%d' "0\$mode") & 16 )) -ne 0 ]; then
      gid=\$(file_gid "\$root") || return 1
      if group_other_members "\$gid" "\$(id -un)"; then
        if [ -n "\$GROUP_OTHERS" ]; then
          refuse_root "\$forced" "Install Root \$root is writable by group \${GROUP_NAME:-\$gid} (mode \$mode), which also holds \$GROUP_OTHERS. That account could replace what 1667 installs there. Run: chmod g-w \$root, choose another Install Root, or pass --force to install here anyway."
        fi
      else
        refuse_root "\$forced" "Install Root \$root is writable by group \$gid (mode \$mode), and this Installer could not read that group's members to see whether anybody else is in it. Run: chmod g-w \$root - or pass --force to install here anyway."
      fi
    fi
  fi
}

ensure_install_root() {
  root=\$1
  if [ -d "\$root" ]; then
    return 0
  fi
  missing=
  path=\$root
  while [ ! -e "\$path" ] && [ "\$path" != "/" ]; do
    missing="\$path
\$missing"
    path=\$(dirname "\$path")
  done
  printf '%s\\n' "\$missing" | while IFS= read -r component; do
    [ -n "\$component" ] || continue
    mkdir -m 0700 "\$component"
  done
}

owner_uid() {
  # Close Install Root lock FD 9 on the stat helper so it cannot pin the lock.
  if stat -f %u "\$1" >/dev/null 2>&1; then
    stat -f %u "\$1" 9>&-
  else
    stat -c %u "\$1" 9>&-
  fi
}

file_gid() {
  if stat -f %g "\$1" >/dev/null 2>&1; then
    stat -f %g "\$1" 9>&-
  else
    stat -c %g "\$1" 9>&-
  fi
}

# Permission bits as octal digits, such as 775.
file_mode() {
  if stat -f %Lp "\$1" >/dev/null 2>&1; then
    stat -f %Lp "\$1" 9>&-
  else
    stat -c %a "\$1" 9>&-
  fi
}

# One canonical transaction renderer for writes and acceptance.
canonical_txn_bytes() {
  phase=\$1
  target=\$2
  digest=\$3
  root=\$4
  printf '%s\\n' "{\\"kind\\":\\"shell-installer\\",\\"schemaVersion\\":1,\\"phase\\":\\"\$phase\\",\\"version\\":\\"\$PRODUCT_VERSION\\",\\"channel\\":\\"\$INSTALL_CHANNEL\\",\\"artifactTarget\\":\\"\$target\\",\\"archiveSha256\\":\\"\$digest\\",\\"installRoot\\":\\"\$root\\",\\"executable\\":\\"\$root/\$ACTIVE_FILE\\"}"
}

write_txn() {
  root=\$1
  phase=\$2
  target=\$3
  digest=\$4
  tmp="\$root/.1667-install-txn.\$\$.tmp"
  rm -f "\$tmp"
  umask 077
  # Noclobber writer is a parenthesized subshell that inherits FD 9; close it.
  if ! (
    exec 9>&-
    set -C
    canonical_txn_bytes "\$phase" "\$target" "\$digest" "\$root" > "\$tmp"
  ); then
    die "Could not create a Transaction Record"
  fi
  mv "\$tmp" "\$root/\$TXN_FILE"
  fsync_path "\$root/\$TXN_FILE"
}

# Accept an existing transaction only when its complete bytes equal one allowed
# canonical phase record. Compare with cmp -s so trailing newlines are not stripped
# (command substitution would drop trailing newlines and accept one extra byte).
validate_txn() {
  file=\$1
  expected_target=\$2
  expected_digest=\$3
  root=\$4
  # Private comparison temp may be rewritten each phase; do not use noclobber here.
  tmp="\$file.validate.\$\$"
  for phase in downloading extracted candidate-ready activated; do
    if ! canonical_txn_bytes "\$phase" "\$expected_target" "\$expected_digest" "\$root" > "\$tmp"; then
      rm -f "\$tmp"
      die "Could not build a comparison Transaction Record"
    fi
    if cmp -s "\$file" "\$tmp"; then
      rm -f "\$tmp"
      printf '%s\\n' "\$phase"
      return 0
    fi
  done
  rm -f "\$tmp"
  die "Install transaction is not a canonical phase record"
}

# Remove the exact reserved extract staging path under Install Root.
# Never glob. A symbolic link is unlinked without following.
remove_extract_stage() {
  root=\$1
  stage="\$root/\$EXTRACT_STAGE"
  if [ -L "\$stage" ]; then
    rm -f "\$stage" 9>&-
    return 0
  fi
  if [ -d "\$stage" ]; then
    rm -rf "\$stage" 9>&-
    return 0
  fi
  if [ -e "\$stage" ]; then
    rm -f "\$stage" 9>&-
  fi
}

# Recovery runs in the lock-owning shell so PROBE_PID stays visible to traps.
# Sets RECOVER_STATUS (none|reset|completed|managed-reset|managed-completed).
# The caller must handle every value explicitly. Do not wrap in command
# substitution: recovery runs in the lock-owning shell so probe traps work.
recover_install() {
  root=\$1
  executable=\$2
  target=\$3
  digest=\$4
  # Exact pinned Release Archive file name for this host/version (never a glob).
  archive=\$5
  RECOVER_STATUS=
  txn="\$root/\$TXN_FILE"
  if [ -L "\$txn" ]; then
    die "Install transaction must not be a symbolic link"
  fi
  if [ ! -e "\$txn" ]; then
    # No Transaction Record: do not delete reserved staging. Ownership is unproven.
    RECOVER_STATUS=none
    return 0
  fi
  if [ ! -f "\$txn" ]; then
    die "Install transaction must be a regular file"
  fi
  validate_managed_file_safety "\$txn" "Install Transaction Record"
  txn_mode=\$(exec 9>&-; file_mode "\$txn") || die "Could not inspect Install Transaction Record permissions"
  [ "\$txn_mode" = 600 ] || die "Install Transaction Record must have mode 600"
  txn_size=\$(exec 9>&-; wc -c < "\$txn" | tr -d ' ')
  [ -n "\$txn_size" ] && [ "\$txn_size" -le "\$MAX_TRANSACTION_BYTES" ] \
    || die "Install Transaction Record is too large"
  txn_text=\$(exec 9>&-; cat "\$txn") || die "Could not read Install Transaction Record"
  txn_kind=\$(exec 9>&-; json_string_field "\$txn_text" kind)
  if [ "\$txn_kind" = managed ]; then
    validate_managed_txn "\$txn" "\$target" "\$root"
    # Managed Transaction Records do not own Shell Installer-only staging.
    # Refuse it before recovery grants cleanup authority.
    refuse_prior_managed_path "\$root/\$EXTRACT_STAGE" "extract staging"
    refuse_prior_managed_path "\$root/\$PROBE_OUTPUT_FILE" "probe output"
    refuse_prior_managed_path "\$root/\$archive" "Release Archive staging"
    recover_managed_install "\$root" "\$executable" "\$target" "\$txn"
    return 0
  fi
  [ "\$txn_kind" = shell-installer ] || die "Install transaction is not a canonical phase record"
  # validate_txn subshell inherits FD 9; close it so a hung validator cannot pin.
  phase=\$(
    exec 9>&-
    validate_txn "\$txn" "\$target" "\$digest" "\$root"
  ) || exit 1
  # Canonical match proves this installer owns reserved staging for cleanup.
  CLEANUP_OWNS_STAGING=1
  case "\$phase" in
    downloading|extracted)
      rm -f "\$root/\$CANDIDATE_FILE" "\$root/\$PREVIOUS_NEXT_FILE" "\$root/\$archive" 9>&-
      remove_extract_stage "\$root"
      clear_txn "\$root"
      RECOVER_STATUS=reset
      return 0
      ;;
    candidate-ready)
      if [ -f "\$executable" ] && [ ! -L "\$executable" ]; then
        if probe_candidate_soft "\$executable" "\$target"; then
          # Rename may have completed before fsync; durable-sync active first.
          fsync_path "\$executable"
          installation_id=\$(
            exec 9>&-
            random_hex_32
          )
          write_ownership "\$root" "\$installation_id" "\$executable" "\$target"
          rm -f "\$root/\$CANDIDATE_FILE"
          remove_extract_stage "\$root"
          clear_txn "\$root"
          RECOVER_STATUS=completed
          return 0
        fi
        die "Install left an active executable that does not match the pinned release"
      fi
      rm -f "\$root/\$CANDIDATE_FILE"
      remove_extract_stage "\$root"
      clear_txn "\$root"
      RECOVER_STATUS=reset
      return 0
      ;;
    activated)
      if [ ! -f "\$executable" ] || [ -L "\$executable" ]; then
        die "Install transaction is activated but the executable is missing"
      fi
      probe_candidate "\$executable" "\$target"
      fsync_path "\$executable"
      ownership="\$root/\$OWNERSHIP_FILE"
      if [ -e "\$ownership" ] || [ -L "\$ownership" ]; then
        validate_managed_ownership "\$root" "\$executable" "\$target"
        [ "\$OWNERSHIP_CHANNEL" = "\$INSTALL_CHANNEL" ] || die "Ownership Record channel does not match the Install Transaction Record"
        fsync_path "\$ownership"
      else
        installation_id=\$(
          exec 9>&-
          random_hex_32
        )
        write_ownership "\$root" "\$installation_id" "\$executable" "\$target"
      fi
      rm -f "\$root/\$CANDIDATE_FILE"
      remove_extract_stage "\$root"
      clear_txn "\$root"
      RECOVER_STATUS=completed
      return 0
      ;;
    *)
      die "Install transaction phase is unsupported: \$phase"
      ;;
  esac
}

# Background curl + wait so INT/TERM traps run during download (foreground
# curl would block trapped signals until the transfer finished).
# Close Install Root lock FD 9 in the child so a parent crash cannot leave the
# advisory lock held by a still-running downloader.
# --connect-timeout and --max-time are portable curl flags; both URL branches
# share the same connect and overall transfer deadlines.
DOWNLOAD_PID=
download_archive() {
  url=\$1
  out=\$2
  command -v curl >/dev/null 2>&1 || die "curl is required"
  # A person watching a terminal gets the transfer bar. A log or a pipe gets
  # silence, so captured output stays free of carriage returns.
  if [ -t 2 ]; then
    progress='--progress-bar'
  else
    progress='--silent'
  fi
  case "\$url" in
    https://*)
      curl -fSL "\$progress" --proto '=https' --proto-redir '=https' \\
        --connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC" \\
        --max-time "\$DOWNLOAD_MAX_TIME_SEC" \\
        --max-filesize "\$MAX_ARCHIVE_BYTES" "\$url" -o "\$out" 9>&- &
      ;;
    http://127.0.0.1:*|http://localhost:*)
      curl -fSL "\$progress" \\
        --connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC" \\
        --max-time "\$DOWNLOAD_MAX_TIME_SEC" \\
        --max-filesize "\$MAX_ARCHIVE_BYTES" "\$url" -o "\$out" 9>&- &
      ;;
    *)
      die "Release Archive URL must use HTTPS"
      ;;
  esac
  DOWNLOAD_PID=\$!
  set +e
  wait "\$DOWNLOAD_PID"
  status=\$?
  set -e
  DOWNLOAD_PID=
  if [ "\$status" -ne 0 ]; then
    rm -f "\$out"
    die "Download failed"
  fi
  # size= subshell inherits FD 9; close it so a hung wc cannot pin the lock.
  size=\$(
    exec 9>&-
    wc -c < "\$out" | tr -d ' '
  )
  if [ "\$size" -le 0 ] || [ "\$size" -gt "\$MAX_ARCHIVE_BYTES" ]; then
    rm -f "\$out"
    die "Release Archive size is outside the bound"
  fi
}

verify_sha256() {
  file=\$1
  expected=\$2
  # Command-substitution subshells inherit FD 9. Close it in the subshell itself
  # (not only pipeline children) so a hanging digest helper cannot pin the lock
  # after the installer parent dies.
  actual=\$(
    exec 9>&-
    file_sha256 "\$file"
  )
  if [ "\$actual" != "\$expected" ]; then
    die "Release Archive SHA-256 digest did not match the pinned value"
  fi
}

file_sha256() {
  # Digest helpers must not inherit Install Root lock FD 9.
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "\$1" 9>&- | awk '{print \$1}' 9>&-
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "\$1" 9>&- | awk '{print \$1}' 9>&-
  else
    die "shasum or sha256sum is required"
  fi
}

random_hex_32() {
  if [ -r /dev/urandom ]; then
    od -An -N16 -tx1 /dev/urandom 9>&- | tr -d ' \\n' 9>&-
    return 0
  fi
  die "Cannot create an installation id"
}

# Canonical Ownership Record bytes for writes and post-replace verification.
canonical_ownership_bytes() {
  id=\$1
  exe=\$2
  target=\$3
  root=\$4
  channel=\$5
  cat 9>&- <<EOF
{
  "schemaVersion": 1,
  "product": "1667",
  "installationId": "\$id",
  "method": "shell",
  "channel": "\$channel",
  "installRoot": "\$root",
  "executable": "\$exe",
  "artifactTarget": "\$target"
}
EOF
}

write_ownership() {
  root=\$1
  id=\$2
  exe=\$3
  target=\$4
  channel=\${5:-\$INSTALL_CHANNEL}
  dest="\$root/\$OWNERSHIP_FILE"
  # Refuse a pre-existing destination that is not a regular non-symlink file
  # (directory, device, or symlink) before any atomic replacement.
  if [ -L "\$dest" ]; then
    die "Ownership Record must not be a symbolic link"
  fi
  if [ -e "\$dest" ] && [ ! -f "\$dest" ]; then
    die "Ownership Record path is not a regular file"
  fi
  tmp="\$root/.1667-install.\$\$.tmp"
  verify="\$root/.1667-install.\$\$.verify"
  rm -f "\$tmp" "\$verify" 9>&-
  umask 077
  # Noclobber writers inherit FD 9; close it in each parenthesized subshell.
  if ! (
    exec 9>&-
    set -C
    canonical_ownership_bytes "\$id" "\$exe" "\$target" "\$root" "\$channel" > "\$tmp"
  ); then
    die "Could not create an Ownership Record"
  fi
  fsync_path "\$tmp"
  # Keep expected bytes for post-replace verification (mv consumes \$tmp).
  if ! (
    exec 9>&-
    set -C
    canonical_ownership_bytes "\$id" "\$exe" "\$target" "\$root" "\$channel" > "\$verify"
  ); then
    rm -f "\$tmp" 9>&-
    die "Could not create an Ownership Record verification copy"
  fi
  mv "\$tmp" "\$dest" 9>&-
  chmod 0600 "\$dest" 9>&-
  # Ownership must be durable before any later Transaction Record removal.
  fsync_path "\$dest"
  fsync_dir "\$root"
  # Verify final path type and exact bytes after atomic replacement.
  if [ -L "\$dest" ] || [ ! -f "\$dest" ]; then
    rm -f "\$verify" 9>&-
    die "Ownership Record path is not a regular file after write"
  fi
  if ! cmp -s "\$dest" "\$verify" 9>&-; then
    rm -f "\$verify" 9>&-
    die "Ownership Record verification failed after write"
  fi
  rm -f "\$verify" 9>&-
}

clear_txn() {
  root=\$1
  rm -f "\$root/\$TXN_FILE" 9>&-
  fsync_dir "\$root"
}

`;
