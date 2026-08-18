#!/usr/bin/env bash
#
# fix-electron-signing.sh — macOS-only dev-environment repair.
#
# Why this exists
# ---------------
# npm installs a *prebuilt, unsigned (or ad-hoc signed)* Electron.app into
# node_modules. Apple's XProtect scanner intermittently matches a malware
# signature against that binary, shows "Malware Blocked and Moved to Trash",
# and deletes the bundle. It is a false positive, but it breaks the dev loop
# every time node_modules is reinstalled, because a fresh `npm install` pulls
# down a fresh unsigned copy.
#
# The fix is to strip the quarantine/provenance extended attributes and give
# the bundle a stable ad-hoc signature, which is what this script does.
#
# What it deliberately does NOT do
# --------------------------------
# It does not touch SIP, Gatekeeper, `spctl`, or any other system-wide macOS
# security control, and it never uses sudo. The only thing it modifies is the
# locally-downloaded Electron.app inside this project's node_modules.
#
# Safe to run repeatedly: `xattr -cr` and `codesign --force` are both
# idempotent. Always exits 0 so it can never break an install.

# No `set -e`: a failure on one bundle must not stop the others, and this
# script must never fail an `npm install`.
set -u

# --- 1. macOS only -----------------------------------------------------------
# Silent no-op everywhere else (Linux/Windows CI, WSL, etc.).
[ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || exit 0

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
NODE_MODULES="$REPO_ROOT/node_modules"

log() { printf 'fix-electron-signing: %s\n' "$1"; }
warn() { printf 'fix-electron-signing: warning: %s\n' "$1" >&2; }

# --- 2. Locate the Electron app bundle(s) ------------------------------------
# Primary: the `electron` package's main export *is* the path to the
# executable (node_modules/electron/index.js returns it). Derive the enclosing
# .app bundle from that rather than hardcoding a path, so a relocated,
# hoisted, or ELECTRON_OVERRIDE_DIST_PATH-redirected install still resolves.
resolve_from_package() {
  local exe app
  exe=$(cd "$REPO_ROOT" && node -p "require('electron')" 2>/dev/null) || return 0
  [ -n "$exe" ] || return 0
  case "$exe" in
    *.app/*)
      # Shortest prefix ending at the first ".app" component.
      app="${exe%%.app/*}.app"
      printf '%s\n' "$app"
      ;;
  esac
}

# Fallback: glob for any Electron.app shipped inside an `electron` package
# under node_modules — top-level/hoisted *and* nested (workspaces, transitive
# installs). -prune stops find from descending into the bundle itself.
resolve_from_glob() {
  [ -d "$NODE_MODULES" ] || return 0
  find "$NODE_MODULES" \
    -type d \
    -path '*/electron/dist/Electron.app' \
    -prune -print 2>/dev/null
}

BUNDLES=$(
  {
    resolve_from_package
    resolve_from_glob
  } | sed '/^[[:space:]]*$/d' | sort -u
)

if [ -z "$BUNDLES" ]; then
  log "no Electron.app bundle found under $NODE_MODULES (nothing to do)"
  exit 0
fi

# --- 3. De-quarantine + ad-hoc sign each bundle ------------------------------
found=0
signed=0

while IFS= read -r app; do
  [ -n "$app" ] || continue

  if [ ! -d "$app" ]; then
    # Expected when XProtect has already trashed the bundle; the preflight
    # check on the start path reports this with recovery instructions.
    log "skipping (not on disk): $app"
    continue
  fi

  found=$((found + 1))
  log "repairing $app"

  # Clear com.apple.quarantine / com.apple.provenance and friends, recursively.
  if ! xattr -cr "$app" 2>/dev/null; then
    warn "xattr -cr failed for $app (continuing)"
  fi

  # Ad-hoc sign ("-" is the ad-hoc identity). No --deep: Apple deprecated it,
  # and signing the outer bundle re-seals it against its nested components.
  if codesign_out=$(codesign --force --sign - "$app" 2>&1); then
    signed=$((signed + 1))
    log "ad-hoc signed $app"
  else
    warn "codesign failed for $app (continuing)"
    [ -n "$codesign_out" ] && printf '%s\n' "$codesign_out" >&2
  fi
done <<EOF
$BUNDLES
EOF

if [ "$found" -eq 0 ]; then
  log "no Electron.app bundle present on disk (run: npm install)"
else
  log "done — $signed of $found bundle(s) ad-hoc signed"
fi

# Never fail an install, a predev hook, or a prestart hook.
exit 0
