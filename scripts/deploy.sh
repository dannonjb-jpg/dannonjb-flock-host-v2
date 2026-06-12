#!/usr/bin/env bash
# scripts/deploy.sh
#
# Enforces reviewBeforeLive (penn-routing-policy.json -> host_validation):
# changes to action-applier, payments, store, or scheduler require --reviewed
# before systemctl restart reaches the live service.
#
# Usage:
#   ./scripts/deploy.sh              # blocks if host_validation files changed
#   ./scripts/deploy.sh --reviewed   # acknowledge you have reviewed the diff
#
# On success: restarts flock-host-v2.service and records the deployed SHA in
# .last-deployed-sha (gitignored runtime marker).

set -euo pipefail

REVIEWED=0
for arg in "$@"; do
  [[ "$arg" == "--reviewed" ]] && REVIEWED=1
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="$REPO_ROOT/.last-deployed-sha"
SERVICE="flock-host-v2.service"

# Paths sourced from penn-routing-policy.json -> taskClasses.host_validation.files.
# Policy names src/order-store/** and src/scheduler.ts; actual layout uses
# src/store/ and src/ops/scheduler.ts respectively.
HOT_PATHS=(
  "src/brain/action-applier.ts"
  "src/payments"
  "src/store"
  "src/ops/scheduler.ts"
  "src/domain/state-machine.ts"
)

cd "$REPO_ROOT"

CURRENT_SHA="$(git rev-parse HEAD)"

# Collect hot files that changed since the last recorded deploy.
# No marker = first deploy; treat as changed (production is unknown state).
CHANGED_HOT=""
if [[ ! -f "$MARKER" ]]; then
  for path in "${HOT_PATHS[@]}"; do
    files="$(git ls-files "$path" 2>/dev/null || true)"
    [[ -n "$files" ]] && CHANGED_HOT+="$files"$'\n'
  done
else
  LAST_SHA="$(cat "$MARKER")"
  if [[ "$LAST_SHA" != "$CURRENT_SHA" ]]; then
    for path in "${HOT_PATHS[@]}"; do
      files="$(git diff --name-only "$LAST_SHA" HEAD -- "$path" 2>/dev/null || true)"
      [[ -n "$files" ]] && CHANGED_HOT+="$files"$'\n'
    done
  fi
fi

if [[ -n "$CHANGED_HOT" ]]; then
  if [[ "$REVIEWED" -eq 0 ]]; then
    echo "------------------------------------------------------------" >&2
    echo "DEPLOY BLOCKED — reviewBeforeLive (penn-routing-policy.json)" >&2
    echo "" >&2
    echo "These host_validation files changed since the last deploy:" >&2
    echo "$CHANGED_HOT" | grep -v '^$' | sed 's/^/  /' >&2
    echo "" >&2
    echo "Review the diff, then re-run with --reviewed:" >&2
    if [[ -f "$MARKER" ]]; then
      echo "  git diff $(cat "$MARKER") HEAD -- ${HOT_PATHS[*]}" >&2
    else
      echo "  git show HEAD -- ${HOT_PATHS[*]}" >&2
    fi
    echo "  ./scripts/deploy.sh --reviewed" >&2
    echo "------------------------------------------------------------" >&2
    exit 1
  fi
  echo "[deploy] --reviewed acknowledged. Hot files in this deploy:" >&2
  echo "$CHANGED_HOT" | grep -v '^$' | sed 's/^/  /' >&2
fi

echo "[deploy] restarting $SERVICE ..."
systemctl restart "$SERVICE"
systemctl status "$SERVICE" --no-pager -l

echo "$CURRENT_SHA" > "$MARKER"
echo "[deploy] done. SHA: $CURRENT_SHA"
