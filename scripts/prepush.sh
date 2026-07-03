#!/usr/bin/env bash
#
# Pre-push gate: run the full verification suite (unit + E2E) before pushing to
# main. Wire it up as a git hook with:
#     ln -sf ../../scripts/prepush.sh .git/hooks/pre-push
# or run it manually / via `npm run verify`.
#
# Exits non-zero (blocking the push) if anything fails.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ Unit tests…"
npm test

echo "▶ E2E smoke tests…"
npm run test:e2e

echo "✓ All checks passed — safe to push."
