#!/usr/bin/env bash
# scripts/precommit-coupling.sh
# Enforces the compositor <-> gate coupling: the Sharp compositor and the
# request_mockup gate in action-applier.ts MUST land in the same commit.
#
# This is a TRIPWIRE scoped to the compositor-swap landing. Once the coupled
# change has merged, REMOVE this hook — action-applier.ts will legitimately
# change on its own afterward, and a forever-rule would produce false blocks.
#
# Install (run from repo root):
# ln -sf ../../scripts/precommit-coupling.sh .git/hooks/pre-commit
# chmod +x scripts/precommit-coupling.sh
# Or, if you prefer not to symlink:
# git config core.hooksPath scripts && mv this file to scripts/pre-commit
#
# NOTE: this fires only where you actually git commit. If you SFTP files to
# the droplet without committing there, it does not run — see _enforcement in
# penn-routing-policy.json.

set -euo pipefail

COMPOSITOR="src/integrations/sharp-compositor.ts"
APPLIER="src/brain/action-applier.ts"

staged="$(git diff --cached --name-only)"

has_compositor=0
has_applier=0
echo "$staged" | grep -qx "$COMPOSITOR" && has_compositor=1 || true
echo "$staged" | grep -qx "$APPLIER" && has_applier=1 || true

# If neither file is in this commit, nothing to enforce.
if [ "$has_compositor" -eq 0 ] && [ "$has_applier" -eq 0 ]; then
 exit 0
fi

# If exactly one is present, the coupling is being split — block.
if [ "$has_compositor" -ne "$has_applier" ]; then
 echo "------------------------------------------------------------" >&2
 echo "COUPLING VIOLATION (penn-routing-policy.json -> coupling)" >&2
 echo "" >&2
 echo "The Sharp compositor and the request_mockup gate must land" >&2
 echo "in the SAME commit. Never split." >&2
 echo "" >&2
 [ "$has_compositor" -eq 1 ] && echo " staged: $COMPOSITOR" >&2
 [ "$has_applier" -eq 1 ] && echo " staged: $APPLIER" >&2
 [ "$has_compositor" -eq 0 ] && echo " MISSING: $COMPOSITOR" >&2
 [ "$has_applier" -eq 0 ] && echo " MISSING: $APPLIER" >&2
 echo "" >&2
 echo "Stage both, or neither. Also confirm the 4->2 variant:'both'" >&2
 echo "bug is resolved-or-dismissed in this same change." >&2
 echo "------------------------------------------------------------" >&2
 exit 1
fi

# Both present: coupling satisfied. Remind about the rider.
echo "[coupling] compositor + gate staged together. Confirm: 4->2 variant:'both' resolved-or-dismissed in this change." >&2
exit 0
