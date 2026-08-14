#!/bin/bash
#
# Build Pipeline Template installer
# Safely adds the pipeline (.claude skills/commands, CLAUDE.md section, specs/, docs/)
# to an EXISTING project without overwriting anything already there.
#
# Usage:
#   bash install.sh /path/to/your/project
#   bash install.sh /path/to/your/project --yes   (skip confirmation)
#
# Safety guarantees:
#   - Never overwrites an existing file. Same-name skills/commands are skipped and reported.
#   - CLAUDE.md is appended to (with a marker so it never appends twice), never replaced.
#   - .gitignore gets missing safety entries appended, existing lines untouched.
#   - Refuses to run with uncommitted changes, so one `git revert` undoes the install.
#   - Everything it did (or skipped) is printed at the end.

set -euo pipefail

MARKER="<!-- build-pipeline-template:v1 -->"
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- helpers ----------
say()  { printf '%s\n' "$*"; }
ok()   { printf '  [added]   %s\n' "$*"; }
skip() { printf '  [skipped] %s (already exists, left untouched)\n' "$*"; }
warn() { printf '  [WARNING] %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------- validate arguments ----------
[ $# -ge 1 ] || die "Usage: bash install.sh /path/to/your/project [--yes]"
TARGET="$1"
AUTO_YES="${2:-}"

[ -d "$TARGET" ] || die "Target folder does not exist: $TARGET"
TARGET="$(cd "$TARGET" && pwd)"
[ "$TARGET" != "$TEMPLATE_DIR" ] || die "Target is the template folder itself. Point at your project instead."
[ -d "$TEMPLATE_DIR/.claude/skills" ] || die "Cannot find template skills next to this script. Run the copy of install.sh that lives inside project-template/."

# ---------- validate git state ----------
if [ ! -d "$TARGET/.git" ]; then
  say "This project is not a git repository yet."
  if [ "$AUTO_YES" = "--yes" ]; then
    REPLY=y
  else
    printf 'Initialize git in %s? [y/N] ' "$TARGET"
    read -r REPLY
  fi
  case "$REPLY" in
    y|Y) git -C "$TARGET" init -b main >/dev/null 2>&1 || git -C "$TARGET" init >/dev/null ;;
    *)   die "Aborted. The installer needs git so the install is one revertible commit." ;;
  esac
fi

if [ -n "$(git -C "$TARGET" status --porcelain)" ] && [ -n "$(git -C "$TARGET" log --oneline -1 2>/dev/null)" ]; then
  git -C "$TARGET" status --short
  die "Uncommitted changes in the project (listed above). Commit or stash them first, then re-run. This keeps the install cleanly revertible."
fi

# ---------- preview and confirm ----------
say ""
say "Installing Build Pipeline Template"
say "  from: $TEMPLATE_DIR"
say "  into: $TARGET"
say ""
if [ "$AUTO_YES" != "--yes" ]; then
  printf 'Proceed? Nothing existing will be overwritten. [y/N] '
  read -r REPLY
  case "$REPLY" in y|Y) ;; *) die "Aborted by user." ;; esac
fi
say ""

ADDED=()

# ---------- 1. skills (per-skill, no clobber) ----------
say "Skills:"
mkdir -p "$TARGET/.claude/skills"
for src in "$TEMPLATE_DIR/.claude/skills/"*/; do
  name="$(basename "$src")"
  dest="$TARGET/.claude/skills/$name"
  if [ -e "$dest" ]; then
    skip ".claude/skills/$name"
  else
    cp -R "$src" "$dest"
    ok ".claude/skills/$name"
    ADDED+=(".claude/skills/$name")
  fi
done

# ---------- 2. commands (per-file, no clobber) ----------
say "Commands:"
mkdir -p "$TARGET/.claude/commands"
for src in "$TEMPLATE_DIR/.claude/commands/"*.md; do
  name="$(basename "$src")"
  dest="$TARGET/.claude/commands/$name"
  if [ -e "$dest" ]; then
    skip ".claude/commands/$name"
  else
    cp "$src" "$dest"
    ok ".claude/commands/$name"
    ADDED+=(".claude/commands/$name")
  fi
done

# ---------- 3. specs/ and docs/ ----------
say "Folders:"
if [ -d "$TARGET/specs" ]; then
  skip "specs/"
else
  mkdir -p "$TARGET/specs"
  touch "$TARGET/specs/.gitkeep"
  ok "specs/"
  ADDED+=("specs/.gitkeep")
fi
if [ -e "$TARGET/docs/pipeline.md" ]; then
  skip "docs/pipeline.md"
else
  mkdir -p "$TARGET/docs"
  cp "$TEMPLATE_DIR/docs/pipeline.md" "$TARGET/docs/pipeline.md"
  ok "docs/pipeline.md"
  ADDED+=("docs/pipeline.md")
fi

# ---------- 4. CLAUDE.md (append with marker, never replace) ----------
say "CLAUDE.md:"
if [ ! -e "$TARGET/CLAUDE.md" ]; then
  { printf '%s\n' "$MARKER"; cat "$TEMPLATE_DIR/CLAUDE.md"; } > "$TARGET/CLAUDE.md"
  ok "CLAUDE.md (created)"
  ADDED+=("CLAUDE.md")
elif grep -qF "$MARKER" "$TARGET/CLAUDE.md"; then
  skip "CLAUDE.md pipeline section (marker already present)"
else
  { printf '\n\n---\n\n%s\n' "$MARKER"; cat "$TEMPLATE_DIR/CLAUDE.md"; } >> "$TARGET/CLAUDE.md"
  ok "CLAUDE.md (pipeline section appended below your existing rules)"
  ADDED+=("CLAUDE.md")
fi

# ---------- 5. .gitignore (append missing safety entries only) ----------
say ".gitignore:"
GITIGNORE="$TARGET/.gitignore"
NEEDED=("node_modules/" ".env" ".env.*" "!.env.example" ".DS_Store" "dist/" "build/" "coverage/" "*.log")
MISSING=()
touch "$GITIGNORE"
for entry in "${NEEDED[@]}"; do
  grep -qxF "$entry" "$GITIGNORE" || MISSING+=("$entry")
done
if [ ${#MISSING[@]} -eq 0 ]; then
  skip ".gitignore (all safety entries already present)"
else
  { printf '\n# added by build-pipeline-template installer\n'; printf '%s\n' "${MISSING[@]}"; } >> "$GITIGNORE"
  ok ".gitignore (appended: ${MISSING[*]})"
  ADDED+=(".gitignore")
fi

# ---------- 6. safety scans (warn only, never modify) ----------
say "Safety checks:"
TRACKED_ENV="$(git -C "$TARGET" ls-files | grep -E '(^|/)\.env(\.[^/]*)?$' | grep -v '\.env\.example$' || true)"
if [ -n "$TRACKED_ENV" ]; then
  warn "These env files are tracked by git and may contain secrets:"
  printf '            %s\n' $TRACKED_ENV
  warn "Untrack them (git rm --cached <file>) and rotate any secrets inside."
else
  say "  [clean]   no .env files tracked by git"
fi
command -v python3 >/dev/null 2>&1 && say "  [clean]   python3 found (design engine will work)" || warn "python3 not found; the ui-ux-pro-max design engine needs it"

# ---------- 7. commit ----------
say ""
if [ ${#ADDED[@]} -eq 0 ]; then
  say "Nothing new to install; project already has everything. No commit made."
else
  ( cd "$TARGET" && git add -- "${ADDED[@]}" && git commit -q -m "chore: add build pipeline template" )
  say "Committed as: chore: add build pipeline template"
  say "Undo anytime with: git revert HEAD"
fi

say ""
say "Done. Next steps:"
say "  1. Open Claude Code in $TARGET"
say "  2. Type / and confirm new-project and new-feature appear"
say "  3. Kick off your first run:  /new-feature <something small>"
