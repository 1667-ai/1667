/**
 * POSIX Shell Installer body. Generated release assets embed pinned version,
 * channel, archive names, and digests. Fresh install only.
 */
import {
  INSTALL_CANDIDATE_FILE,
  INSTALL_LOCK_FILE,
  INSTALL_PACKAGE_STAGING_FILE,
  INSTALL_PREVIOUS_FILE,
  INSTALL_PREVIOUS_NEXT_FILE,
  INSTALL_TRANSACTION_FILE
} from "../shared/install-layout.js";
import {
  INSTALL_ACTIVE_EXECUTABLE,
  INSTALL_OWNERSHIP_FILE
} from "../shared/install-ownership-record.js";
import {
  MAX_RELEASE_ARTIFACT_GZIP_BYTES,
  MAX_RELEASE_ARTIFACT_TAR_BYTES,
  MAX_RELEASE_EXECUTABLE_BYTES,
  MAX_RELEASE_TOTAL_FILE_BYTES,
  RELEASE_TRANSFER_CONNECT_TIMEOUT_MS,
  RELEASE_TRANSFER_TOTAL_TIMEOUT_MS
} from "../shared/release-artifact-bounds.js";
import { SHELL_INSTALLER_DURABLE } from "./release-install-script-durable.js";
import {
  shellInstallerExtract,
  type ShellInstallerExtractLayout
} from "./release-install-script-extract-lib.js";
import { SHELL_INSTALLER_LOCK } from "./release-install-script-lock-lib.js";
import { SHELL_INSTALLER_PROBE } from "./release-install-script-probe-lib.js";
import { SHELL_INSTALLER_HELPERS } from "./release-install-script-shell-lib.js";

const SHELL_MAX_ARCHIVE_BYTES = MAX_RELEASE_ARTIFACT_GZIP_BYTES;
const SHELL_MAX_TAR_BYTES = MAX_RELEASE_ARTIFACT_TAR_BYTES;
const SHELL_MAX_EXECUTABLE_BYTES = MAX_RELEASE_EXECUTABLE_BYTES;
const SHELL_MAX_FILE_BYTES = MAX_RELEASE_TOTAL_FILE_BYTES;
const SHELL_DOWNLOAD_CONNECT_TIMEOUT_SEC = RELEASE_TRANSFER_CONNECT_TIMEOUT_MS / 1_000;
const SHELL_DOWNLOAD_MAX_TIME_SEC = RELEASE_TRANSFER_TOTAL_TIMEOUT_MS / 1_000;

export function shellInstallerBody(input: {
  readonly version: string;
  readonly channel: string;
  readonly repository: string;
  readonly assetBase: string;
  readonly nameLines: string;
  readonly digestLines: string;
  readonly extractLayout: ShellInstallerExtractLayout;
}): string {
  const extract = shellInstallerExtract(input.extractLayout);
  return `#!/bin/sh
# 1667 Shell Installer — channel ${input.channel}, version ${input.version}
# Generated release asset. Do not edit. Attest before you trust a local copy.
set -eu

PRODUCT_VERSION='${input.version}'
INSTALL_CHANNEL='${input.channel}'
GITHUB_REPOSITORY='${input.repository}'
ASSET_BASE='${input.assetBase}'
MAX_ARCHIVE_BYTES=${SHELL_MAX_ARCHIVE_BYTES}
# Complete decompressed tar stream bound (headers, payloads, padding, terminators).
MAX_TAR_BYTES=${SHELL_MAX_TAR_BYTES}
# Expanded 1667 executable bound (same shared limit as managed upgrade).
MAX_EXECUTABLE_BYTES=${SHELL_MAX_EXECUTABLE_BYTES}
# Cumulative bytes in all regular-file members.
MAX_FILE_BYTES=${SHELL_MAX_FILE_BYTES}
# Portable curl deadlines: connect bound, then overall transfer bound.
DOWNLOAD_CONNECT_TIMEOUT_SEC=${SHELL_DOWNLOAD_CONNECT_TIMEOUT_SEC}
DOWNLOAD_MAX_TIME_SEC=${SHELL_DOWNLOAD_MAX_TIME_SEC}
OWNERSHIP_FILE='${INSTALL_OWNERSHIP_FILE}'
LOCK_FILE='${INSTALL_LOCK_FILE}'
TXN_FILE='${INSTALL_TRANSACTION_FILE}'
CANDIDATE_FILE='${INSTALL_CANDIDATE_FILE}'
PREVIOUS_FILE='${INSTALL_PREVIOUS_FILE}'
PREVIOUS_NEXT_FILE='${INSTALL_PREVIOUS_NEXT_FILE}'
PACKAGE_STAGING_FILE='${INSTALL_PACKAGE_STAGING_FILE}'
ACTIVE_FILE='${INSTALL_ACTIVE_EXECUTABLE}'
# Exact reserved extract staging under the Install Root (never PID-scoped).
EXTRACT_STAGE='.1667-extract'
# Bounded candidate version probe (no GNU timeout; portable POSIX shell).
PROBE_TIMEOUT_SEC=5
PROBE_MAX_OUTPUT_BLOCKS=8
PROBE_OUTPUT_FILE='.1667-probe-output'
# 1 only after this process proves ownership of reserved staging (canonical
# Transaction Record, or a verified clean fresh root that starts this install).
CLEANUP_OWNS_STAGING=0

main() {
  prefix=
  prefix_set=0
  dry_run=0
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --prefix)
        [ "\$#" -ge 2 ] || die "--prefix requires an absolute path"
        prefix=\$2
        prefix_set=1
        shift 2
        ;;
      --prefix=*)
        prefix=\${1#--prefix=}
        prefix_set=1
        shift
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        die "Unknown option: \$1"
        ;;
    esac
  done

  target=\$(detect_target) || exit 1
  case "\$target" in
${input.nameLines}
    *) die "Unsupported target: \$target" ;;
  esac
  case "\$target" in
${input.digestLines}
    *) die "Unsupported target: \$target" ;;
  esac

  # No --prefix selects the default. Explicit empty --prefix / --prefix= is usage error.
  if [ "\$prefix_set" -eq 0 ]; then
    prefix="\$HOME/.local/bin"
  elif [ -z "\$prefix" ]; then
    die "--prefix requires an absolute path"
  fi
  case "\$prefix" in
    /*) ;;
    *) die "--prefix must be an absolute path" ;;
  esac
  # Ownership Record installRoot cannot be filesystem root (needs a path component).
  # Reject before dry-run or mutation so every accepted prefix can produce a record.
  if [ "\$prefix" = "/" ]; then
    die "--prefix must not be the filesystem root"
  fi
  validate_install_root "\$prefix" || exit 1

  if [ "\$dry_run" -eq 1 ]; then
    printf 'dry-run: would install 1667 %s (%s) for %s into %s\\n' \\
      "\$PRODUCT_VERSION" "\$INSTALL_CHANNEL" "\$target" "\$prefix"
    printf 'dry-run: archive %s/%s\\n' "\$ASSET_BASE" "\$archive"
    return 0
  fi

  umask 077
  ensure_install_root "\$prefix"
  prefix=\$(CDPATH= cd "\$prefix" && pwd -P)
  assert_json_safe_path "\$prefix" "Install Root"
  executable="\$prefix/\$ACTIVE_FILE"
  # CLEANUP_OWNS_STAGING stays 0 until recovery validates a txn or the fresh path
  # verifies a clean root and begins this install.
  CLEANUP_OWNS_STAGING=0
  acquire_lock "\$prefix"
  # EXIT cleans once. INT/TERM clear traps, clean once, then exit 128+signal.
  trap 'cleanup_install "\$prefix" "\$archive"' EXIT
  trap 'on_install_signal INT "\$prefix" "\$archive"' INT
  trap 'on_install_signal TERM "\$prefix" "\$archive"' TERM

  # Run recovery in this shell so PROBE_PID is visible to INT/TERM traps.
  RECOVER_STATUS=
  recover_install "\$prefix" "\$executable" "\$target" "\$digest" "\$archive" || exit 1
  if [ "\$RECOVER_STATUS" = completed ]; then
    printf 'Recovered 1667 %s (%s) for %s at %s\\n' \\
      "\$PRODUCT_VERSION" "\$INSTALL_CHANNEL" "\$target" "\$executable"
    trap - EXIT INT TERM
    release_lock "\$prefix"
    return 0
  fi

  if [ -e "\$executable" ] || [ -L "\$executable" ]; then
    die "Refusing to replace an existing 1667 at \$executable. Run '1667 upgrade' instead."
  fi

  # Fail closed on prior managed or reserved staging paths. Do not delete them.
  # The persistent Install Root lock file is allowed to remain.
  refuse_prior_managed_path "\$prefix/\$OWNERSHIP_FILE" "Ownership Record"
  refuse_prior_managed_path "\$prefix/\$PREVIOUS_FILE" "previous executable"
  refuse_prior_managed_path "\$prefix/\$PREVIOUS_NEXT_FILE" "staged previous executable"
  refuse_prior_managed_path "\$prefix/\$CANDIDATE_FILE" "candidate executable"
  refuse_prior_managed_path "\$prefix/\$EXTRACT_STAGE" "extract staging"
  refuse_prior_managed_path "\$prefix/\$PROBE_OUTPUT_FILE" "probe output"
  refuse_prior_managed_path "\$prefix/\$PACKAGE_STAGING_FILE" "package staging"
  refuse_prior_managed_path "\$prefix/\$archive" "Release Archive staging"

  # Clean root proven; this install now owns reserved staging for EXIT cleanup.
  CLEANUP_OWNS_STAGING=1
  url="\$ASSET_BASE/\$archive"
  write_txn "\$prefix" "downloading" "\$target" "\$digest"
  archive_path="\$prefix/\$archive"
  rm -f "\$archive_path"
  say "Downloading 1667 \$PRODUCT_VERSION for \$target"
  download_archive "\$url" "\$archive_path"
  say "Checking the download"
  verify_sha256 "\$archive_path" "\$digest"
  write_txn "\$prefix" "extracted" "\$target" "\$digest"
  say "Unpacking"
  extract_candidate "\$prefix" "\$archive_path" "\$archive"
  rm -f "\$archive_path"
  say "Starting 1667 once to confirm it runs"
  probe_candidate "\$prefix/\$CANDIDATE_FILE" "\$target"
  # Candidate bytes must be durable before candidate-ready is published.
  # Power loss after a durable txn must not leave a missing or corrupt candidate.
  fsync_path "\$prefix/\$CANDIDATE_FILE"
  write_txn "\$prefix" "candidate-ready" "\$target" "\$digest"
  mv "\$prefix/\$CANDIDATE_FILE" "\$executable"
  chmod 0755 "\$executable"
  fsync_path "\$executable"
  # Close the gap: durable activated mark before ownership write.
  write_txn "\$prefix" "activated" "\$target" "\$digest"
  # random_hex_32 subshell inherits FD 9; close it so a hung id helper cannot pin.
  installation_id=\$(
    exec 9>&-
    random_hex_32
  )
  write_ownership "\$prefix" "\$installation_id" "\$executable" "\$target"
  # Ownership is already fsynced inside write_ownership; clear txn only after that.
  clear_txn "\$prefix"
  trap - EXIT INT TERM
  release_lock "\$prefix"
  printf 'Installed 1667 %s (%s) for %s to %s\\n' \\
    "\$PRODUCT_VERSION" "\$INSTALL_CHANNEL" "\$target" "\$executable"
  case ":\$PATH:" in
    *":\$prefix:"*) ;;
    *)
      printf 'Add this directory to PATH:\\n  export PATH="%s:\$PATH"\\n' "\$prefix"
      ;;
  esac
}

usage() {
  printf 'Usage: install-%s.sh [--prefix /absolute/path] [--dry-run]\\n' "\$INSTALL_CHANNEL"
  printf 'Installs 1667 %s from the pinned GitHub release archive.\\n' "\$PRODUCT_VERSION"
  printf 'This installer is for a fresh Install Root only. Use 1667 upgrade later.\\n'
}

cleanup_install() {
  root=\$1
  archive=\$2
  # Delete reserved staging only when this process owns it (canonical txn or
  # a verified clean fresh install that already began). Always release the lock.
  if [ "\${CLEANUP_OWNS_STAGING:-0}" -eq 1 ]; then
    # Remove staging while this process still holds the lock, then release.
    # Releasing first lets a successor publish staging that this cleanup would delete.
    rm -f "\$root/\$CANDIDATE_FILE" "\$root/\$PROBE_OUTPUT_FILE" \
      "\$root/\$archive" "\$root/\$PACKAGE_STAGING_FILE" 2>/dev/null || true
    remove_extract_stage "\$root"
  fi
  release_lock "\$root"
}

# Kill a background download so wait returns and this trap can exit promptly.
stop_download() {
  if [ -n "\${DOWNLOAD_PID:-}" ]; then
    kill "\$DOWNLOAD_PID" 2>/dev/null || true
    set +e
    wait "\$DOWNLOAD_PID" 2>/dev/null
    set -e
    DOWNLOAD_PID=
  fi
}

# Kill a bounded version probe (and its watchdog) so traps can exit promptly.
# Escalate to SIGKILL so a TERM-resistant candidate cannot hold the lock.
stop_probe() {
  if [ -n "\${PROBE_WATCHDOG_PID:-}" ]; then
    kill "\$PROBE_WATCHDOG_PID" 2>/dev/null || true
    set +e
    wait "\$PROBE_WATCHDOG_PID" 2>/dev/null
    set -e
    PROBE_WATCHDOG_PID=
  fi
  if [ -n "\${PROBE_PID:-}" ]; then
    kill "\$PROBE_PID" 2>/dev/null || true
    sleep 1
    kill -9 "\$PROBE_PID" 2>/dev/null || true
    set +e
    wait "\$PROBE_PID" 2>/dev/null
    set -e
    PROBE_PID=
  fi
}

# Conventional status: 128 + signal number (INT=2 → 130, TERM=15 → 143).
# Clears traps first so EXIT does not run cleanup a second time.
on_install_signal() {
  sig=\$1
  root=\$2
  archive=\$3
  trap - EXIT INT TERM
  stop_download
  stop_probe
  cleanup_install "\$root" "\$archive"
  case "\$sig" in
    INT) exit 130 ;;
    TERM) exit 143 ;;
    *) exit 1 ;;
  esac
}

die() {
  printf '1667 install: %s\\n' "\$*" >&2
  exit 1
}

# Progress goes to stderr so that stdout carries only the install result.
# Without it the installer is silent for the whole transfer, and a slow network
# is indistinguishable from a stall.
say() {
  printf '1667 install: %s\\n' "\$*" >&2
}

# Refuse any prior managed path (regular file, directory, or symbolic link).
# Fresh install does not remove managed state left by a prior install or upgrade.
refuse_prior_managed_path() {
  managed=\$1
  label=\$2
  if [ -e "\$managed" ] || [ -L "\$managed" ]; then
    die "Refusing to install over prior managed state (\$label) at \$managed. Remove it only after you confirm it is safe, or run '1667 upgrade' on a managed install."
  fi
}
${SHELL_INSTALLER_DURABLE}
${SHELL_INSTALLER_LOCK}
${SHELL_INSTALLER_HELPERS}
${extract}
${SHELL_INSTALLER_PROBE}
main "\$@"
`;
}
