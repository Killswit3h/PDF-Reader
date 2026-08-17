---
name: git-workflow
description: Standard git practices for the build pipeline. Defines repo setup, branching model, commit conventions, merge rules, and safety recipes. Every pipeline phase that touches code follows this skill. Use when initializing a repo, creating branches, committing, merging, tagging a release, or recovering from a git mistake.
---

# Git Workflow

Git is the pipeline's safety net and its history book. Followed consistently, it means any build can be undone, any change can be traced to a spec requirement, and `main` is always a working app.

## Repo setup (new projects, before the first commit)

1. `git init` immediately after scaffolding, before writing feature code.
2. Create `.gitignore` BEFORE the first commit. Minimum entries for a web project:

```
node_modules/
.env
.env.*
!.env.example
dist/
build/
.next/
out/
coverage/
.DS_Store
*.log
```

Adjust for the stack (e.g. `__pycache__/`, `.venv/` for Python). A `.env` file that gets committed even once lives in history forever; rotating those secrets is the only fix.

3. Commit `.env.example` (placeholder values only), never `.env`.
4. First commit: `chore: scaffold project` containing the clean skeleton.
5. If the user has a GitHub remote, add it and push `main` right away.

## Branching model

- **`main` is always working.** It never receives direct feature commits; it only moves by merge from a branch that passed inspection.
- One branch per pipeline run, created before any build code is written:
  - New feature: `feat/<short-slug>` (e.g. `feat/email-reminders`)
  - Bug fix: `fix/<short-slug>`
  - Exception: a brand-new project builds its first version directly on `main`, since there is nothing to protect yet. From v2 onward, everything goes through branches.
- Never build two pipeline runs on the same branch.

## Commit conventions

Use Conventional Commits, imperative mood, lowercase type:

```
feat: add round logging form (FR-3, FR-4)
fix: prevent duplicate score submission on double click
chore: configure eslint and prettier
refactor: extract handicap calculation into lib/handicap.ts
docs: add spec and build plan for reminders feature
test: cover error paths for rounds API
```

- Small and atomic: one logical change per commit. A finished work-order task is the natural unit.
- Reference spec requirement numbers (FR-x) in the subject or body when a commit implements them; this is what makes history traceable back to the spec.
- Body (optional) explains **why**, not what; the diff already shows what.
- Never commit commented-out code blocks or debug prints; delete them first.

## When the pipeline commits

| Moment | Commit |
|--------|--------|
| Scaffold complete (new project) | `chore: scaffold project` |
| Spec + plan approved | `docs: add research brief, spec, and build plan` (the `specs/` files are versioned too) |
| Each completed work-order task | `feat:`/`fix:` per the task |
| Security findings fixed | `fix: <finding>` referencing the finding ID |
| Inspection PASS | merge to `main` |

Run `git status` before and after every commit; the working tree should be clean between tasks. Never let a build finish with a dirty tree of unrelated changes.

## Merging and releases

- Merge to `main` only after the Inspector's PASS verdict. FAIL means the branch keeps receiving fix commits until re-inspection passes.
- Merge with `git merge --no-ff feat/<slug>` (keeps the feature visible as a unit in history), or a squash merge if the branch history is messy. Delete the branch after merge.
- If a GitHub remote exists: push the branch and open a PR instead of merging locally; merge via the PR so there is a review record.
- Tag shipped versions: `git tag v1.2.0 && git push --tags`. Version bumps: major = breaking, minor = new feature, patch = fix.

## Safety rules and recovery

- NEVER `git push --force` on `main`. On a solo feature branch, `--force-with-lease` only, and only to clean up your own unpushed history.
- NEVER `git reset --hard` without checking `git status` first; it destroys uncommitted work.
- Committed something wrong (not yet pushed): `git commit --amend` (message or staged fixes) or `git reset --soft HEAD~1` (undo commit, keep changes).
- Already pushed: `git revert <sha>`; never rewrite pushed history on shared branches.
- Committed a secret: rotate the secret immediately; history cleanup is secondary to rotation.
- Need to switch tasks with half-done work: `git stash push -m "wip: <what>"`, later `git stash pop`.
- Before anything destructive, `git branch backup/<date>` costs nothing and has saved many builds.
