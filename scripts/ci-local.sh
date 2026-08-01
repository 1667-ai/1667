#!/usr/bin/env bash
# The same gates CI runs, on every target this machine can reach.
#
# Runs every gate on every target this machine can reach. Linux runs in Docker
# because it is the only way to exercise the plain-HTTP loopback provider
# suites: ownedLoopbackHttpSupportedOn is Linux-only, so roughly thirty tests
# skip silently on macOS and Windows and are never otherwise executed.
#
# This local script does not reach darwin-x64 or windows-x64. Hosted CI tests
# these targets on their native runners.
set -uo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly IMAGE="node:22.22-bookworm"
readonly CONTAINER="1667-ci-local"
# Long enough for the loopback suites on emulated amd64, short enough that a
# wedged run is noticed rather than left overnight.
readonly TARGET_TIMEOUT_S=1800

PUBLISH_STATUS=0
KEEP_CONTAINER=0
ONLY_TARGET=""

usage() {
  cat <<'USAGE'
Usage: scripts/ci-local.sh [options]

  --status         publish the result as a "local-ci" commit status on HEAD
  --only <target>  run one target (darwin-arm64|linux-x64|linux-arm64)
  --keep           keep the Docker container for faster reruns
  -h, --help       show this help

Exits nonzero if any target fails, so it is usable from a pre-push hook.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --status) PUBLISH_STATUS=1; shift ;;
    --keep) KEEP_CONTAINER=1; shift ;;
    --only) ONLY_TARGET="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

RESULT_NAMES=()
RESULT_STATES=()
RESULT_NOTES=()

record() {
  RESULT_NAMES+=("$1")
  RESULT_STATES+=("$2")
  RESULT_NOTES+=("$3")
}

wants() {
  [ -z "$ONLY_TARGET" ] || [ "$ONLY_TARGET" = "$1" ]
}

step() {
  printf '\n\033[1m==> %s\033[0m\n' "$1"
}

# --- darwin-arm64: native ----------------------------------------------------
run_darwin_arm64() {
  local target="darwin-arm64"
  wants "$target" || return 0
  step "$target (native)"
  local start; start=$(date +%s)
  (
    cd "$REPO_ROOT" || exit 1
    set -e
    npm run build
    npm test
    cd tui
    bun install --frozen-lockfile
    bun run typecheck
    bun test
    bun run build:standalone
  )
  local code=$?
  local elapsed=$(( $(date +%s) - start ))
  if [ "$code" -eq 0 ]; then
    record "$target" pass "${elapsed}s"
  else
    record "$target" fail "${elapsed}s, exit ${code}"
  fi
}

# --- linux: Docker -----------------------------------------------------------
ensure_container() {
  local platform="$1" name="$2"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --platform "$platform" \
    -v "$REPO_ROOT:/src:ro" "$IMAGE" sleep infinity >/dev/null || return 1
  # node_modules is host-built for darwin, so the container installs its own.
  docker exec "$name" bash -c '
    set -e
    mkdir -p /app
    tar -C /src --exclude=node_modules --exclude=.git -cf - . | tar -C /app -xf -
    cd /app
    npm ci --no-audit --no-fund
    npm i -g bun@1.3.14
    useradd -m runner
    chown -R runner /app
  ' >/dev/null 2>&1
}

run_linux() {
  local target="$1" platform="$2"
  wants "$target" || return 0
  step "$target (docker $platform)"
  local name="${CONTAINER}-${target}"
  local runtime_test="npm test"
  # Docker exposes every arm64 host CPU to the amd64 emulator. Letting Node
  # launch one translated benchmark worker per CPU creates artificial
  # contention that native CI does not have; keep the workload and budgets,
  # but bound only this emulated lane's file-level scheduling.
  if [ "$target" = "linux-x64" ] && [ "$(uname -m)" = "arm64" ]; then
    runtime_test="env AI_1667_TEST_EMULATED_X64=1 npm test -- --test-concurrency=1"
  fi
  local start; start=$(date +%s)

  if ! ensure_container "$platform" "$name"; then
    record "$target" fail "container setup failed"
    return 0
  fi

  # Unprivileged: root defeats the permission-based failure injection several
  # storage tests rely on, which silently turns real assertions into passes.
  docker exec -u runner "$name" bash -c "
    cd /app
    set -e
    timeout ${TARGET_TIMEOUT_S} ${runtime_test}
    cd tui
    bun install --frozen-lockfile
    bun run typecheck
    timeout ${TARGET_TIMEOUT_S} bun test
  "
  local code=$?
  local elapsed=$(( $(date +%s) - start ))

  [ "$KEEP_CONTAINER" -eq 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true

  if [ "$code" -eq 0 ]; then
    record "$target" pass "${elapsed}s"
  elif [ "$code" -eq 124 ]; then
    record "$target" fail "${elapsed}s, TIMED OUT (wedged, not slow)"
  else
    record "$target" fail "${elapsed}s, exit ${code}"
  fi
}

# --- run ---------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "docker is not running; Linux targets cannot be covered" >&2
  exit 2
fi

run_darwin_arm64
run_linux linux-arm64 linux/arm64
run_linux linux-x64 linux/amd64

# --- summary -----------------------------------------------------------------
printf '\n\033[1m==> summary\033[0m\n'
failed=0
for i in "${!RESULT_NAMES[@]}"; do
  state="${RESULT_STATES[$i]}"
  if [ "$state" = "pass" ]; then
    printf '  \033[32mPASS\033[0m  %-14s %s\n' "${RESULT_NAMES[$i]}" "${RESULT_NOTES[$i]}"
  else
    printf '  \033[31mFAIL\033[0m  %-14s %s\n' "${RESULT_NAMES[$i]}" "${RESULT_NOTES[$i]}"
    failed=1
  fi
done
# The pre-push hook reads this. Only a full run may record a pass: --only
# covers one target and must never satisfy the gate.
marker="$(git -C "$REPO_ROOT" rev-parse --git-dir)/local-ci-pass"
if [ "$failed" -eq 0 ] && [ -z "$ONLY_TARGET" ]; then
  git -C "$REPO_ROOT" rev-parse HEAD > "$marker"
  echo "  recorded local-ci pass for $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
else
  rm -f "$marker"
fi

if [ "$PUBLISH_STATUS" -eq 1 ]; then
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  covered="$(IFS=,; echo "${RESULT_NAMES[*]}")"
  # A green status has to mean every target ran. Publishing on failed=0 alone
  # would let --only report success after one target, and an unrecognised
  # --only report success having run none at all: a passing required check for
  # work nothing verified, which is worse than no check.
  if [ "$failed" -eq 0 ] && [ -n "$ONLY_TARGET" ]; then
    echo "  refusing to publish: --only ran a partial set (${covered:-none})" >&2
    exit 2
  fi
  if [ "$failed" -eq 0 ] && [ "${#RESULT_NAMES[@]}" -eq 0 ]; then
    echo "  refusing to publish: no target ran" >&2
    exit 2
  fi
  if [ "$failed" -eq 0 ]; then
    state="success"
    description="passed: ${covered}"
  else
    state="failure"
    description="failed; see local run"
  fi
  # Commit statuses are free: this gives a required check without Actions minutes.
  gh api -X POST "repos/{owner}/{repo}/statuses/${sha}" \
    -f state="$state" \
    -f context="local-ci" \
    -f description="${description:0:139}" >/dev/null \
    && echo "  published local-ci=${state} on ${sha:0:8}" \
    || echo "  could not publish commit status" >&2
fi

exit "$failed"
