/** Bounded candidate probe functions embedded in the Shell Installer. */
export const SHELL_INSTALLER_PROBE = `
# Extract one JSON string field by fixed key name. Key is caller-controlled and
# never user-supplied. Compare extracted values with shell string equality so
# PRODUCT_VERSION / target dots and plus signs are literal (not ERE metachars).
json_string_field() {
  text=\$1
  key=\$2
  printf '%s\\n' "\$text" | tr ',' '\\n' | sed -n "s/.*\\"\$key\\"[[:space:]]*:[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1
}

# Portable bounded version probe for generated install.sh (macOS + POSIX sh).
# - Candidate does not inherit Install Root lock FD 9.
# - Runtime is bounded without GNU timeout (watchdog + sleep).
# - Output is bounded with the POSIX file-size resource limit.
# - Child and watchdog are terminated and reaped on timeout and by stop_probe.
PROBE_PID=
PROBE_WATCHDOG_PID=
MANAGED_PROBE_VERSION=

run_bounded_probe() {
  candidate=\$1
  out=\$2
  rm -f "\$out"
  # Noclobber makes an output-path race fail closed.
  # The subshell exec makes PROBE_PID the candidate PID, not a wrapper PID.
  (
    exec 9>&-
    umask 077
    ulimit -f "\$PROBE_MAX_OUTPUT_BLOCKS"
    set -C
    exec "\$candidate" --version --json > "\$out" 2>/dev/null
  ) &
  PROBE_PID=\$!
  probe_pid=\$PROBE_PID
  # Watchdog must not hold the lock either.
  (
    exec 9>&-
    watchdog_timer=
    trap '
      trap - INT TERM
      if [ -n "\${watchdog_timer:-}" ]; then
        kill "\$watchdog_timer" 2>/dev/null || true
        wait "\$watchdog_timer" 2>/dev/null || true
      fi
      exit 0
    ' INT TERM
    sleep "\$PROBE_TIMEOUT_SEC" &
    watchdog_timer=\$!
    wait "\$watchdog_timer"
    watchdog_timer=
    trap - INT TERM
    if kill -0 "\$probe_pid" 2>/dev/null; then
      kill "\$probe_pid" 2>/dev/null || true
      sleep 1
      kill -9 "\$probe_pid" 2>/dev/null || true
    fi
  ) &
  PROBE_WATCHDOG_PID=\$!
  set +e
  wait "\$PROBE_PID"
  status=\$?
  set -e
  PROBE_PID=
  if [ -n "\${PROBE_WATCHDOG_PID:-}" ]; then
    kill "\$PROBE_WATCHDOG_PID" 2>/dev/null || true
    set +e
    wait "\$PROBE_WATCHDOG_PID" 2>/dev/null
    set -e
    PROBE_WATCHDOG_PID=
  fi
  return "\$status"
}

probe_candidate() {
  candidate=\$1
  target=\$2
  out="\${candidate%/*}/\$PROBE_OUTPUT_FILE"
  if ! run_bounded_probe "\$candidate" "\$out"; then
    rm -f "\$out"
    die "Candidate version probe failed"
  fi
  # Preserve trailing newlines for identity JSON (command substitution would drop them).
  # Each capture subshell inherits FD 9; close it so a hung reader cannot pin the lock.
  if ! out_text=\$(
    exec 9>&-
    cat "\$out"
  ); then
    rm -f "\$out"
    die "Candidate version probe failed"
  fi
  rm -f "\$out"
  product=\$(
    exec 9>&-
    json_string_field "\$out_text" product
  )
  version=\$(
    exec 9>&-
    json_string_field "\$out_text" productVersion
  )
  art=\$(
    exec 9>&-
    json_string_field "\$out_text" artifactTarget
  )
  kind=\$(
    exec 9>&-
    json_string_field "\$out_text" buildKind
  )
  [ "\$product" = "1667" ] || die "Candidate product is not 1667"
  [ "\$version" = "\$PRODUCT_VERSION" ] || die "Candidate version did not match the pinned release"
  [ "\$art" = "\$target" ] || die "Candidate target did not match this host"
  [ "\$kind" = "release" ] || die "Candidate is not a release build"
}

probe_candidate_soft() {
  candidate=\$1
  target=\$2
  out="\${candidate%/*}/\$PROBE_OUTPUT_FILE"
  if ! run_bounded_probe "\$candidate" "\$out"; then
    rm -f "\$out"
    return 1
  fi
  if ! out_text=\$(
    exec 9>&-
    cat "\$out"
  ); then
    rm -f "\$out"
    return 1
  fi
  rm -f "\$out"
  product=\$(
    exec 9>&-
    json_string_field "\$out_text" product
  )
  version=\$(
    exec 9>&-
    json_string_field "\$out_text" productVersion
  )
  art=\$(
    exec 9>&-
    json_string_field "\$out_text" artifactTarget
  )
  kind=\$(
    exec 9>&-
    json_string_field "\$out_text" buildKind
  )
  [ "\$product" = "1667" ] || return 1
  [ "\$version" = "\$PRODUCT_VERSION" ] || return 1
  [ "\$art" = "\$target" ] || return 1
  [ "\$kind" = "release" ] || return 1
  return 0
}

# Probe an existing managed active executable. Unlike the release candidate
# probe, this accepts any release version so an older installer can bootstrap
# across a changed package/NOTICE file. The caller invokes this directly so
# signal traps can see PROBE_PID; the version is returned in MANAGED_PROBE_VERSION.
probe_managed_active() {
  candidate=\$1
  target=\$2
  out="\${candidate%/*}/\$PROBE_OUTPUT_FILE"
  if ! run_bounded_probe "\$candidate" "\$out"; then
    rm -f "\$out"
    die "Managed active executable version probe failed"
  fi
  if ! out_text=\$(
    exec 9>&-
    cat "\$out"
  ); then
    rm -f "\$out"
    die "Managed active executable version probe failed"
  fi
  rm -f "\$out"
  product=\$(exec 9>&-; json_string_field "\$out_text" product)
  version=\$(exec 9>&-; json_string_field "\$out_text" productVersion)
  art=\$(exec 9>&-; json_string_field "\$out_text" artifactTarget)
  kind=\$(exec 9>&-; json_string_field "\$out_text" buildKind)
  [ "\$product" = "1667" ] || die "Managed active executable is not 1667"
  [ "\$art" = "\$target" ] || die "Managed active executable target did not match this host"
  [ "\$kind" = "release" ] || die "Managed active executable is not a release build"
  version_length=\$(printf '%s' "\$version" | wc -c | tr -d ' ')
  [ -n "\$version" ] && [ "\$version_length" -le 128 ] || die "Managed active executable version is invalid"
  semver_valid "\$version" || die "Managed active executable version is invalid"
  MANAGED_PROBE_VERSION=\$version
}
`;
