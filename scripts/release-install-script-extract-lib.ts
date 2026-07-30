/**
 * Archive layout validation and Candidate extraction for the Shell Installer.
 * Embedded into the generated install script as POSIX shell.
 *
 * Security model (before any member extract):
 * 1. Decompress the gzip stream into a private tar under extract staging.
 * 2. Bound every decompressed byte to MAX_TAR_BYTES (headers, payloads,
 *    padding, and terminators).
 * 3. Walk the physical ustar stream in header / body-padding / trailing phases
 *    (same phases as UstarStreamParser). Accept only canonical POSIX ustar
 *    whose member paths match the pinned numeric layout. Reject PAX, GNU
 *    long-name/link, sparse, special, link, duplicate, traversal, truncated,
 *    and excess trailing nonzero data.
 * 4. Extract only the pinned 1667 member from the validated private tar.
 *
 * Header IPC uses fixed records only (D:0, F:<id>:<size>, or fixed errors).
 * Paths are never returned to the shell; awk maps full paths to member IDs.
 */
import { shellInstallerUstarParser } from "./release-install-script-ustar-parser.js";

export interface ShellInstallerExtractLayout {
  /** Stem-relative paths; index 0 is "" (directory = stem). */
  readonly memberRelPaths: readonly string[];
  /** Index of the executable regular-file member (stem/1667). */
  readonly executableMemberId: number;
}

/**
 * Renders extract helpers for one portable installer that pins a uniform
 * published archive member layout.
 */
export function shellInstallerExtract(layout: ShellInstallerExtractLayout): string {
  const { memberRelPaths, executableMemberId } = layout;
  if (memberRelPaths.length === 0 || memberRelPaths[0] !== "") {
    throw new Error("Shell extract layout must start with the directory member");
  }
  if (
    executableMemberId <= 0
    || executableMemberId >= memberRelPaths.length
    || memberRelPaths[executableMemberId] !== "1667"
  ) {
    throw new Error("Shell extract layout is missing the 1667 executable member");
  }
  const seenPaths = new Set<string>();
  for (const relPath of memberRelPaths.slice(1)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(relPath) || seenPaths.has(relPath)) {
      throw new Error(`Shell extract layout has an unsafe or duplicate member: ${relPath}`);
    }
    seenPaths.add(relPath);
  }
  const memberCount = memberRelPaths.length;
  if (memberCount > 30) {
    throw new Error("Shell extract layout exceeds the numeric bitmask capacity");
  }
  const expectedMask = (2 ** memberCount) - 1;

  const memberAssignLines = memberRelPaths.map((rel, id) => {
    if (rel.length === 0) return `  m${id}="\$stem"`;
    return `  m${id}="\$stem/${rel}"`;
  }).join("\n");

  const ustarParser = shellInstallerUstarParser(memberCount);

  return `
# Tools required for bounded decompress and physical ustar validation.
require_extract_tools() {
  command -v gzip >/dev/null 2>&1 || die "gzip is required"
  command -v dd >/dev/null 2>&1 || die "dd is required"
  command -v od >/dev/null 2>&1 || die "od is required"
  command -v cmp >/dev/null 2>&1 || die "cmp is required"
}

# Decompress gzip into a private tar path. Every decompressed byte counts
# against MAX_TAR_BYTES. Reads at most one 512-byte block past the bound so
# overflow is visible without unbounded write. Close FD 9 on gzip so a hung
# decompress cannot pin the Install Root lock.
decompress_archive_bounded() {
  archive_path=\$1
  tar_path=\$2
  # MAX_TAR_BYTES is a multiple of 512 (shared release bound).
  max_blocks=\$((MAX_TAR_BYTES / 512))
  # Private status file next to the private tar (same extract stage).
  gzip_status_path="\${tar_path}.gzip-status"
  rm -f "\$tar_path" "\$gzip_status_path"
  # Capture gzip exit in the status file (POSIX sh has no pipefail). dd
  # iflag=fullblock makes count mean complete 512-byte blocks on GNU dd and
  # macOS BSD dd. Close FD 9 in the subshell and on gzip.
  (
    exec 9>&-
    {
      gs=0
      gzip -dc "\$archive_path" 9>&- || gs=\$?
      echo "\$gs" > "\$gzip_status_path"
    } | dd bs=512 count=\$((max_blocks + 1)) iflag=fullblock of="\$tar_path" 2>/dev/null
  ) || true
  size=\$(
    exec 9>&-
    wc -c < "\$tar_path" | tr -d ' '
  )
  if [ -z "\$size" ] || [ "\$size" -le 0 ]; then
    die "Archive decompression failed"
  fi
  if [ "\$size" -gt "\$MAX_TAR_BYTES" ]; then
    # Prefer expanded-size when past the bound, even if gzip got SIGPIPE.
    die "Release archive expanded size is outside the bound"
  fi
  # Command substitution strips the trailing newline from the status file.
  gzip_status=\$(
    exec 9>&-
    if [ -f "\$gzip_status_path" ]; then
      cat "\$gzip_status_path"
    fi
  )
  rm -f "\$gzip_status_path"
  # At or below the bound require gzip status 0 so a bad CRC cannot pass.
  if [ -z "\$gzip_status" ] || [ "\$gzip_status" -ne 0 ]; then
    die "Archive decompression failed"
  fi
}

# Read one 512-byte block at index i into hdr_path (private tar, block seek).
ustar_read_block() {
  tar_path=\$1
  hdr_path=\$2
  i=\$3
  (
    exec 9>&-
    dd if="\$tar_path" of="\$hdr_path" bs=512 skip="\$i" count=1 2>/dev/null
  ) || die "Archive structure is truncated or not block-aligned"
}

${ustarParser}

# Body + padding phase for one regular-file member. Seeks by block; does not
# stream executable payload bytes through awk. Final partial block must be zero
# past the declared size (same rule as UstarStreamParser padding).
ustar_skip_member_body() {
  tar_path=\$1
  hdr_path=\$2
  i=\$3
  fsize=\$4
  blocks=\$5
  body_blocks=\$(((fsize + 511) / 512))
  end=\$((i + 1 + body_blocks))
  if [ "\$end" -gt "\$blocks" ]; then
    die "Archive structure is truncated or not block-aligned"
  fi
  if [ "\$fsize" -gt 0 ]; then
    rem=\$((fsize % 512))
    if [ "\$rem" -ne 0 ]; then
      last=\$((i + body_blocks))
      ustar_read_block "\$tar_path" "\$hdr_path" "\$last"
      pad_ok=\$(
        exec 9>&-
        od -An -v -tu1 -N512 "\$hdr_path" 9>&- | awk -v rem="\$rem" '
          {
            for (i = 1; i <= NF; i++) b[n++] = \$i + 0
          }
          END {
            if (n != 512) { print "bad"; exit 1 }
            for (i = rem; i < 512; i++) {
              if (b[i] != 0) { print "bad"; exit 1 }
            }
            print "ok"
          }
        '
      ) || die "Archive structure is truncated or not block-aligned"
      [ "\$pad_ok" = ok ] || die "Archive structure is truncated or not block-aligned"
    fi
  fi
  # Caller advances the block cursor to end.
  USTAR_NEXT_I=\$end
}

# Trailing phase: require the second zero block, then only zero blocks to EOF.
ustar_consume_trailing() {
  tar_path=\$1
  hdr_path=\$2
  zero=\$3
  i=\$4
  blocks=\$5
  # i points at the block after the first zero of the end marker.
  while [ "\$i" -lt "\$blocks" ]; do
    ustar_read_block "\$tar_path" "\$hdr_path" "\$i"
    cmp -s "\$hdr_path" "\$zero" 9>&- || die "Archive has excess trailing nonzero data"
    i=\$((i + 1))
  done
  USTAR_NEXT_I=\$i
}

# Walk every 512-byte block of the private tar (already size-bounded). Require
# the exact pinned member set via a numeric bitmask (no path inventory file).
validate_ustar_physical() {
  tar_path=\$1
  stem=\$2
  stage=\$3
  size=\$(
    exec 9>&-
    wc -c < "\$tar_path" | tr -d ' '
  )
  if [ -z "\$size" ] || [ "\$size" -le 0 ] || [ "\$size" -gt "\$MAX_TAR_BYTES" ]; then
    die "Release archive expanded size is outside the bound"
  fi
  if [ "\$((size % 512))" -ne 0 ]; then
    die "Archive structure is truncated or not block-aligned"
  fi
  blocks=\$((size / 512))
  if [ "\$blocks" -lt 2 ]; then
    die "Archive structure is truncated or not block-aligned"
  fi
  hdr="\$stage/.ustar-hdr"
  zero="\$stage/.ustar-zero"
  rm -f "\$hdr" "\$zero"
  (
    exec 9>&-
    dd if=/dev/zero of="\$zero" bs=512 count=1 2>/dev/null
  ) || die "Could not prepare ustar validation scratch"
  # Canonical full member paths for this archive stem (generated layout).
${memberAssignLines}
  i=0
  zero_run=0
  saw_end=0
  seen=0
  file_bytes=0
  exesize=
  expected_mask=${expectedMask}
  exec_id=${executableMemberId}
  while [ "\$i" -lt "\$blocks" ]; do
    ustar_read_block "\$tar_path" "\$hdr" "\$i"
    if cmp -s "\$hdr" "\$zero" 9>&-; then
      zero_run=\$((zero_run + 1))
      if [ "\$zero_run" -eq 2 ]; then
        saw_end=1
        i=\$((i + 1))
        ustar_consume_trailing "\$tar_path" "\$hdr" "\$zero" "\$i" "\$blocks"
        i=\$USTAR_NEXT_I
        break
      fi
      i=\$((i + 1))
      continue
    fi
    if [ "\$zero_run" -ne 0 ]; then
      die "Archive structure is truncated or not block-aligned"
    fi
    parsed=\$(
      exec 9>&-
      parse_ustar_header "\$hdr"
    ) || die "Archive contains a symbolic link, hard link, special entry, or non-ustar header"
    # Trusted compact records only. Never word-split free-form paths.
    case "\$parsed" in
      zero)
        die "Archive structure is truncated or not block-aligned"
        ;;
      bad|"")
        die "Archive contains a symbolic link, hard link, special entry, or non-ustar header"
        ;;
      layout)
        die "Archive layout is not the exact pinned Release Archive layout"
        ;;
      D:0)
        bit=1
        if [ "\$((seen & bit))" -ne 0 ]; then
          die "Archive layout is not the exact pinned Release Archive layout"
        fi
        seen=\$((seen | bit))
        i=\$((i + 1))
        ;;
      F:*)
        rest="\${parsed#F:}"
        mid="\${rest%%:*}"
        fsize="\${rest#*:}"
        case "\$mid" in
          "" | *[!0-9]*)
            die "Archive layout is not the exact pinned Release Archive layout"
            ;;
        esac
        case "\$fsize" in
          "" | *[!0-9]*)
            die "Archive layout is not the exact pinned Release Archive layout"
            ;;
        esac
        if [ "\$mid" -le 0 ] || [ "\$mid" -ge ${memberCount} ]; then
          die "Archive layout is not the exact pinned Release Archive layout"
        fi
        # Reject F:id:size forms with extra colon payload (path leak / confuse).
        case "\$fsize" in
          *:*)
            die "Archive layout is not the exact pinned Release Archive layout"
            ;;
        esac
        if [ "\$fsize" -gt "\$((MAX_FILE_BYTES - file_bytes))" ]; then
          die "Release archive file bytes are outside the bound"
        fi
        file_bytes=\$((file_bytes + fsize))
        bit=\$((1 << mid))
        if [ "\$((seen & bit))" -ne 0 ]; then
          die "Archive layout is not the exact pinned Release Archive layout"
        fi
        seen=\$((seen | bit))
        if [ "\$mid" -eq "\$exec_id" ]; then
          if [ "\$fsize" -le 0 ] || [ "\$fsize" -gt "\$MAX_EXECUTABLE_BYTES" ]; then
            die "Release executable size is outside the bound"
          fi
          exesize=\$fsize
        fi
        ustar_skip_member_body "\$tar_path" "\$hdr" "\$i" "\$fsize" "\$blocks"
        i=\$USTAR_NEXT_I
        ;;
      *)
        die "Archive contains a symbolic link, hard link, special entry, or non-ustar header"
        ;;
    esac
  done
  if [ "\$saw_end" -ne 1 ]; then
    die "Archive structure is truncated or not block-aligned"
  fi
  if [ -z "\$exesize" ] || [ "\$seen" -ne "\$expected_mask" ]; then
    die "Archive layout is not the exact pinned Release Archive layout"
  fi
  rm -f "\$hdr" "\$zero"
}

# Extract only the pinned 1667 executable into private reserved staging.
# Does not trust archive ownership or modes. Enforces the expanded size bound
# on the complete decompressed stream before extraction. Enforces the
# executable size bound on header claim and on extracted bytes.
extract_candidate() {
  root=\$1
  archive_path=\$2
  archive=\$3
  stem=\${archive%.tar.gz}
  require_extract_tools
  # One exact reserved staging path, protected by the Install Root lock.
  stage="\$root/\$EXTRACT_STAGE"
  remove_extract_stage "\$root"
  mkdir -m 0700 "\$stage"
  tar_path="\$stage/archive.tar"
  decompress_archive_bounded "\$archive_path" "\$tar_path"
  validate_ustar_physical "\$tar_path" "\$stem" "\$stage"
  member="\$stem/1667"
  # Extract only the expected regular executable member from the private
  # validated tar. Never preserve archive member UID/GID. As root, tar defaults
  # to same-owner (GNU tar and macOS bsdtar), which would install files as the
  # release runner. Close FD 9 so a surviving extract child cannot hold the lock.
  tar --no-same-owner -xf "\$tar_path" -C "\$stage" "\$member" 9>&-
  candidate="\$stage/\$member"
  [ -f "\$candidate" ] || die "Archive is missing the 1667 executable"
  [ ! -L "\$candidate" ] || die "Archive executable must not be a symbolic link"
  # Expanded output bound before activation (header claim already checked).
  size=\$(
    exec 9>&-
    wc -c < "\$candidate" | tr -d ' '
  )
  if [ "\$size" -le 0 ] || [ "\$size" -gt "\$MAX_EXECUTABLE_BYTES" ]; then
    die "Release executable size is outside the bound"
  fi
  rm -f "\$root/\$CANDIDATE_FILE"
  mv "\$candidate" "\$root/\$CANDIDATE_FILE"
  # Installer-chosen mode; do not preserve archive modes.
  chmod 0755 "\$root/\$CANDIDATE_FILE"
  remove_extract_stage "\$root"
}

`;
}
