/** Managed-install bootstrap and recovery embedded in the Shell Installer. */
export const SHELL_INSTALLER_MANAGED = `
canonical_ownership_compact_bytes() {
  id=\$1
  exe=\$2
  target=\$3
  root=\$4
  channel=\$5
  printf '%s\\n' "{\\"schemaVersion\\":1,\\"product\\":\\"1667\\",\\"installationId\\":\\"\$id\\",\\"method\\":\\"shell\\",\\"channel\\":\\"\$channel\\",\\"installRoot\\":\\"\$root\\",\\"executable\\":\\"\$exe\\",\\"artifactTarget\\":\\"\$target\\"}"
}

# Extract a bounded JSON string without splitting on commas. Paths may contain
# commas, and the complete canonical-byte comparison below remains authoritative.
managed_json_string_field() {
  text=\$1
  key=\$2
  printf '%s\\n' "\$text" \
    | sed -n "s/.*\\\"\$key\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" \
    | head -n 1
}

validate_managed_file_safety() {
  file=\$1
  label=\$2
  if [ -L "\$file" ] || [ ! -f "\$file" ]; then
    die "\$label must be a regular non-symbolic-link file"
  fi
  forced=\${MANAGED_FORCE:-0}
  owner=\$(owner_uid "\$file") || die "Could not inspect \$label ownership"
  me=\$(id -u)
  if [ "\$owner" != "\$me" ]; then
    refuse_root "\$forced" "\$label belongs to user \$owner, and you are \$(id -un). 1667 replaces files there during an upgrade, which it cannot do as another user."
    if [ "\$forced" -eq 1 ]; then return 0; fi
  fi
  mode=\$(file_mode "\$file") || die "Could not inspect \$label permissions"
  if [ \$(( \$(printf '%d' "0\$mode") & 2 )) -ne 0 ]; then
    refuse_root "\$forced" "\$label is writable by every account on this machine (mode \$mode). Any of them could replace what 1667 installs there."
    if [ "\$forced" -eq 1 ]; then return 0; fi
  fi
  if [ \$(( \$(printf '%d' "0\$mode") & 16 )) -ne 0 ]; then
    gid=\$(file_gid "\$file") || die "Could not inspect \$label group"
    if group_other_members "\$gid" "\$(id -un)"; then
      if [ -n "\$GROUP_OTHERS" ]; then
        refuse_root "\$forced" "\$label is writable by group \${GROUP_NAME:-\$gid} (mode \$mode), which also holds \$GROUP_OTHERS."
        if [ "\$forced" -eq 1 ]; then return 0; fi
      fi
    else
      refuse_root "\$forced" "\$label is writable by group \$gid (mode \$mode), and this Installer could not read that group's members."
      if [ "\$forced" -eq 1 ]; then return 0; fi
    fi
  fi
}

probe_managed_owned() {
  file=\$1
  label=\$2
  target=\$3
  validate_managed_file_safety "\$file" "\$label"
  probe_managed_active "\$file" "\$target"
}

# POSIX awk implementation of the shared SemVer grammar. Numeric identifiers
# cannot have leading zeroes. Prerelease and build identifiers use only the
# characters allowed by shared/semver.ts.
semver_valid() {
  value=\$1
  printf '%s\\n' "\$value" | awk '
    function numeric(s) { return s ~ /^(0|[1-9][0-9]*)$/ }
    function identifier(s) { return s ~ /^[0-9A-Za-z-]+$/ && s != "" }
    {
      if (index(\$0, " ") || \$0 == "") exit 1
      plus = index(\$0, "+")
      if (plus && index(substr(\$0, plus + 1), "+")) exit 1
      core = plus ? substr(\$0, 1, plus - 1) : \$0
      build = plus ? substr(\$0, plus + 1) : ""
      if (build != "") {
        n = split(build, b, ".")
        for (i = 1; i <= n; i++) if (!identifier(b[i])) exit 1
      } else if (plus) exit 1
      dash = index(core, "-")
      pre = dash ? substr(core, dash + 1) : ""
      base = dash ? substr(core, 1, dash - 1) : core
      if (dash && pre == "") exit 1
      if (split(base, v, ".") != 3) exit 1
      for (i = 1; i <= 3; i++) if (!numeric(v[i])) exit 1
      if (pre != "") {
        n = split(pre, p, ".")
        for (i = 1; i <= n; i++) {
          if (!identifier(p[i])) exit 1
          if (p[i] ~ /^[0-9]+$/ && !numeric(p[i])) exit 1
        }
      }
      exit 0
    }
    { exit 1 }
  ' 9>&-
}

# Compare two already validated SemVer values. Print -1, 0, or 1. Keep numeric
# comparison textual so large core identifiers do not lose precision in awk.
semver_compare() {
  LC_ALL=C awk -v left="\$1" -v right="\$2" '
    function parse(value, which, plus, dash, core, pre, parts, count, i) {
      plus = index(value, "+")
      if (plus) value = substr(value, 1, plus - 1)
      dash = index(value, "-")
      if (dash) {
        core = substr(value, 1, dash - 1)
        pre = substr(value, dash + 1)
      } else {
        core = value
        pre = ""
      }
      count = split(core, parts, "[.]")
      if (which == "left") {
        lmajor = parts[1]
        lminor = parts[2]
        lpatch = parts[3]
      } else {
        rmajor = parts[1]
        rminor = parts[2]
        rpatch = parts[3]
      }
      if (pre == "") {
        if (which == "left") lpre_count = 0
        else rpre_count = 0
        return
      }
      count = split(pre, parts, "[.]")
      if (which == "left") {
        lpre_count = count
        for (i = 1; i <= count; i++) lpre[i] = parts[i]
      } else {
        rpre_count = count
        for (i = 1; i <= count; i++) rpre[i] = parts[i]
      }
    }
    function compare_numeric(left_value, right_value) {
      if (length(left_value) != length(right_value)) {
        return length(left_value) < length(right_value) ? -1 : 1
      }
      if (("x" left_value) == ("x" right_value)) return 0
      return ("x" left_value) < ("x" right_value) ? -1 : 1
    }
    function compare_identifier(left_value, right_value, left_numeric, right_numeric) {
      left_numeric = left_value ~ /^[0-9]+$/
      right_numeric = right_value ~ /^[0-9]+$/
      if (left_numeric && right_numeric) return compare_numeric(left_value, right_value)
      if (left_numeric != right_numeric) return left_numeric ? -1 : 1
      if (left_value == right_value) return 0
      return ("x" left_value) < ("x" right_value) ? -1 : 1
    }
    function compare_prerelease(left_count, right_count, count, i, comparison) {
      if (left_count == 0) return right_count == 0 ? 0 : 1
      if (right_count == 0) return -1
      count = left_count > right_count ? left_count : right_count
      for (i = 1; i <= count; i++) {
        if (i > left_count) return -1
        if (i > right_count) return 1
        comparison = compare_identifier(lpre[i], rpre[i])
        if (comparison != 0) return comparison
      }
      return 0
    }
    function compare_versions(comparison) {
      comparison = compare_numeric(lmajor, rmajor)
      if (comparison != 0) return comparison
      comparison = compare_numeric(lminor, rminor)
      if (comparison != 0) return comparison
      comparison = compare_numeric(lpatch, rpatch)
      if (comparison != 0) return comparison
      return compare_prerelease(lpre_count, rpre_count)
    }
    BEGIN {
      parse(left, "left")
      parse(right, "right")
      print compare_versions()
    }
  ' 9>&-
}

validate_managed_ownership() {
  root=\$1
  executable=\$2
  target=\$3
  file="\$root/\$OWNERSHIP_FILE"
  if [ -L "\$file" ]; then
    die "Ownership Record must not be a symbolic link"
  fi
  if [ ! -f "\$file" ]; then
    die "Refusing to replace an existing 1667: Ownership Record is missing (unmanaged installation)"
  fi
  validate_managed_file_safety "\$file" "Ownership Record"
  mode=\$(file_mode "\$file") || return 1
  [ "\$mode" = 600 ] || die "Ownership Record must have mode 600"
  size=\$(exec 9>&-; wc -c < "\$file" | tr -d ' ')
  [ -n "\$size" ] && [ "\$size" -le 16384 ] || die "Ownership Record is too large"
  text=\$(exec 9>&-; cat "\$file") || die "Could not read Ownership Record"
  id=\$(managed_json_string_field "\$text" installationId)
  method=\$(managed_json_string_field "\$text" method)
  channel=\$(managed_json_string_field "\$text" channel)
  id_length=\$(printf '%s' "\$id" | wc -c | tr -d ' ')
  [ "\$id_length" -eq 32 ] || die "Ownership Record installation id is invalid"
  case "\$id" in *[!0-9a-f]*) die "Ownership Record installation id is invalid" ;; esac
  case "\$channel" in stable|beta) ;; *) die "Ownership Record channel is invalid" ;; esac
  [ "\$method" = shell ] || die "Ownership Record method is invalid"
  expected="\$root/.1667-ownership-validate.\$\$"
  rm -f "\$expected"
  if canonical_ownership_bytes "\$id" "\$executable" "\$target" "\$root" "\$channel" > "\$expected" && cmp -s "\$file" "\$expected"; then
    rm -f "\$expected"
    OWNERSHIP_ID=\$id
    OWNERSHIP_CHANNEL=\$channel
    return 0
  fi
  if canonical_ownership_compact_bytes "\$id" "\$executable" "\$target" "\$root" "\$channel" > "\$expected" && cmp -s "\$file" "\$expected"; then
    rm -f "\$expected"
    OWNERSHIP_ID=\$id
    OWNERSHIP_CHANNEL=\$channel
    return 0
  fi
  rm -f "\$expected"
  die "Ownership Record is not a canonical managed record"
}

json_bool_field() {
  text=\$1
  key=\$2
  printf '%s\\n' "\$text" | tr ',' '\\n' \
    | sed -n "s/.*\\\"\$key\\\"[[:space:]]*:[[:space:]]*//p" \
    | head -n 1 | tr -d ' }'
}

canonical_managed_txn_bytes() {
  phase=\$1
  operation=\$2
  channel=\$3
  update_channel=\$4
  active_version=\$5
  candidate_version=\$6
  installation_id=\$7
  root=\$8
  target=\$9
  # Declared serializer contract: serializeInstallTransactionRecord in
  # tui/src/install-transaction-record.ts. It writes phase as the final key.
  printf '%s\\n' "{\\"kind\\":\\"managed\\",\\"schemaVersion\\":1,\\"operation\\":\\"\$operation\\",\\"channel\\":\\"\$channel\\",\\"updateChannel\\":\$update_channel,\\"activeVersion\\":\\"\$active_version\\",\\"candidateVersion\\":\\"\$candidate_version\\",\\"installationId\\":\\"\$installation_id\\",\\"installRoot\\":\\"\$root\\",\\"executable\\":\\"\$root/\$ACTIVE_FILE\\",\\"artifactTarget\\":\\"\$target\\",\\"phase\\":\\"\$phase\\"}"
}

write_managed_txn() {
  root=\$1
  phase=\$2
  operation=\$3
  channel=\$4
  update_channel=\$5
  active_version=\$6
  candidate_version=\$7
  installation_id=\$8
  target=\$9
  tmp="\$root/.1667-managed-txn.\$\$.tmp"
  rm -f "\$tmp"
  umask 077
  if ! (
    exec 9>&-
    set -C
    canonical_managed_txn_bytes "\$phase" "\$operation" "\$channel" \
      "\$update_channel" "\$active_version" "\$candidate_version" \
      "\$installation_id" "\$root" "\$target" > "\$tmp"
  ); then
    die "Could not create a managed Transaction Record"
  fi
  mv "\$tmp" "\$root/\$TXN_FILE"
  fsync_path "\$root/\$TXN_FILE"
}

validate_managed_txn() {
  file=\$1
  target=\$2
  root=\$3
  text=\$(exec 9>&-; cat "\$file") || die "Could not read managed Transaction Record"
  kind=\$(managed_json_string_field "\$text" kind)
  phase=\$(managed_json_string_field "\$text" phase)
  operation=\$(managed_json_string_field "\$text" operation)
  channel=\$(managed_json_string_field "\$text" channel)
  update_channel=\$(json_bool_field "\$text" updateChannel)
  active_version=\$(managed_json_string_field "\$text" activeVersion)
  candidate_version=\$(managed_json_string_field "\$text" candidateVersion)
  installation_id=\$(managed_json_string_field "\$text" installationId)
  [ "\$kind" = managed ] || die "Install transaction kind is unsupported"
  case "\$phase" in candidate-ready|ownership-pending) ;; *) die "Managed transaction phase is invalid" ;; esac
  case "\$operation" in upgrade|rollback) ;; *) die "Managed transaction operation is invalid" ;; esac
  case "\$channel" in stable|beta) ;; *) die "Managed transaction channel is invalid" ;; esac
  case "\$update_channel" in true|false) ;; *) die "Managed transaction updateChannel is invalid" ;; esac
  if ! semver_valid "\$active_version" || ! semver_valid "\$candidate_version"; then
    die "Managed transaction versions are invalid"
  fi
  id_length=\$(printf '%s' "\$installation_id" | wc -c | tr -d ' ')
  [ "\$id_length" -eq 32 ] || die "Managed transaction installation id is invalid"
  case "\$installation_id" in *[!0-9a-f]*) die "Managed transaction installation id is invalid" ;; esac
  expected="\$file.validate.\$\$"
  rm -f "\$expected"
  if canonical_managed_txn_bytes "\$phase" "\$operation" "\$channel" "\$update_channel" "\$active_version" "\$candidate_version" "\$installation_id" "\$root" "\$target" > "\$expected" && cmp -s "\$file" "\$expected"; then
    rm -f "\$expected"
    MANAGED_PHASE=\$phase
    MANAGED_OPERATION=\$operation
    MANAGED_CHANNEL=\$channel
    MANAGED_UPDATE_CHANNEL=\$update_channel
    MANAGED_ACTIVE_VERSION=\$active_version
    MANAGED_CANDIDATE_VERSION=\$candidate_version
    MANAGED_INSTALLATION_ID=\$installation_id
    return 0
  fi
  rm -f "\$expected"
  die "Install transaction is not a canonical managed record"
}

finish_managed_recovery() {
  root=\$1
  executable=\$2
  target=\$3
  if [ -e "\$root/\$PREVIOUS_NEXT_FILE" ] || [ -L "\$root/\$PREVIOUS_NEXT_FILE" ]; then
    if [ -L "\$root/\$PREVIOUS_NEXT_FILE" ] || [ ! -f "\$root/\$PREVIOUS_NEXT_FILE" ]; then
      die "Managed transaction rollback staging is invalid"
    fi
    probe_managed_owned "\$root/\$PREVIOUS_NEXT_FILE" "rollback staging" "\$target"
    previous_version=\$MANAGED_PROBE_VERSION
    [ "\$previous_version" = "\$MANAGED_ACTIVE_VERSION" ] || die "Managed transaction rollback staging does not match the active version"
    if [ -e "\$root/\$PREVIOUS_FILE" ] || [ -L "\$root/\$PREVIOUS_FILE" ]; then
      validate_managed_file_safety "\$root/\$PREVIOUS_FILE" "rollback executable"
    fi
    mv "\$root/\$PREVIOUS_NEXT_FILE" "\$root/\$PREVIOUS_FILE"
    fsync_path "\$root/\$PREVIOUS_FILE"
    fsync_dir "\$root"
  elif [ -e "\$root/\$PREVIOUS_FILE" ]; then
    if [ -L "\$root/\$PREVIOUS_FILE" ] || [ ! -f "\$root/\$PREVIOUS_FILE" ]; then
      die "Managed transaction rollback executable is invalid"
    fi
    probe_managed_owned "\$root/\$PREVIOUS_FILE" "rollback executable" "\$target"
    previous_version=\$MANAGED_PROBE_VERSION
    [ "\$previous_version" = "\$MANAGED_ACTIVE_VERSION" ] || die "Managed transaction rollback executable does not match the active version"
  else
    die "Managed transaction has no verified rollback executable"
  fi
  if [ "\$MANAGED_UPDATE_CHANNEL" = true ]; then
    recovery_channel=\$MANAGED_CHANNEL
  else
    recovery_channel=\$OWNERSHIP_CHANNEL
  fi
  write_ownership "\$root" "\$MANAGED_INSTALLATION_ID" "\$executable" "\$target" "\$recovery_channel"
  rm -f "\$root/\$CANDIDATE_FILE" "\$root/\$PACKAGE_STAGING_FILE"
  remove_extract_stage "\$root"
  clear_txn "\$root"
  RECOVER_STATUS=managed-completed
}

recover_managed_install() {
  root=\$1
  executable=\$2
  target=\$3
  validate_managed_ownership "\$root" "\$executable" "\$target"
  [ "\$OWNERSHIP_ID" = "\$MANAGED_INSTALLATION_ID" ] || die "Managed transaction installation id does not match Ownership Record"
  CLEANUP_OWNS_STAGING=1
  case "\$MANAGED_PHASE" in
    candidate-ready)
      if [ -f "\$executable" ] && [ ! -L "\$executable" ]; then
        probe_managed_owned "\$executable" "managed active executable" "\$target"
        active_version=\$MANAGED_PROBE_VERSION
        if [ "\$active_version" = "\$MANAGED_ACTIVE_VERSION" ]; then
          rm -f "\$root/\$CANDIDATE_FILE" "\$root/\$PREVIOUS_NEXT_FILE" \
            "\$root/\$PACKAGE_STAGING_FILE"
          remove_extract_stage "\$root"
          clear_txn "\$root"
          RECOVER_STATUS=managed-reset
          return 0
        fi
        if [ "\$active_version" = "\$MANAGED_CANDIDATE_VERSION" ]; then
          finish_managed_recovery "\$root" "\$executable" "\$target"
          return 0
        fi
      fi
      die "Managed transaction active executable does not match its record"
      ;;
    ownership-pending)
      if [ ! -f "\$executable" ] || [ -L "\$executable" ]; then
        die "Managed transaction active executable is missing"
      fi
      probe_managed_owned "\$executable" "managed active executable" "\$target"
      active_version=\$MANAGED_PROBE_VERSION
      [ "\$active_version" = "\$MANAGED_CANDIDATE_VERSION" ] || die "Managed transaction active executable does not match its record"
      finish_managed_recovery "\$root" "\$executable" "\$target"
      ;;
  esac
}
`;
