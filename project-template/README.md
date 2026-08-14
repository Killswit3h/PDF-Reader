# Project Template - Structured Build Pipeline

A drop-in folder that gives any coding project a consistent, multi-agent way to build new apps and add features, based on the pipeline:

```
Deep Researcher → Spec Designer → Developer Project Manager
                → [ Frontend Agent | Backend Agent | Security Agent ]
                → Inspector → Final Product / Added Feature
```

## How to install into a project

**Existing project (recommended): use the installer.** From Terminal:

```bash
bash ~/Documents/Coding\ Projects/Developer\ Tree\ Skills/project-template/install.sh /path/to/your/project
```

The installer is safe by design: it refuses to run if the project has uncommitted changes, never overwrites an existing file (same-name skills, commands, and docs are skipped and reported), appends the pipeline section to an existing `CLAUDE.md` instead of replacing it (and never appends twice), adds only missing safety entries to `.gitignore`, warns if any `.env` file is tracked by git, and records everything as a single commit. Undo the whole install anytime with `git revert HEAD`. Add `--yes` to skip the confirmation prompt.

**New empty project:** copy the contents of this folder as-is (`.claude/`, `CLAUDE.md`, `specs/`, `docs/`), or just run the installer against the empty folder and let it `git init` for you.

Requires Python 3 on the machine for the design engine (macOS has it; no packages to install).

## How to use (Claude Code in the Cursor terminal)

Open the Claude Code terminal in your project and run one of:

- `/new-project a golf handicap tracker where my friends and I log rounds and see trends`
- `/new-feature add email reminders the day before a scheduled round`

Or just describe what you want; `CLAUDE.md` tells Claude to route buildable requests into the pipeline.

You get asked questions at two checkpoints only: approving the **spec** (what gets built) and approving the **plan** (how it gets built). After that it builds, security-reviews, and inspects autonomously, looping on fixes until the inspection passes.

## What each piece is

| Path | Role |
|------|------|
| `.claude/commands/new-project.md` | Full pipeline for a brand new app |
| `.claude/commands/new-feature.md` | Pipeline scoped to a feature in an existing app |
| `.claude/skills/deep-researcher/` | Phase 1: clarify, explore codebase, research prior art |
| `.claude/skills/spec-designer/` | Phase 2: EARS requirements, acceptance criteria, error table |
| `.claude/skills/dev-project-manager/` | Phase 3: stack, architecture, integration contract, work orders, coordination |
| `.claude/skills/frontend-agent/` | Build track: UI, driven by the ui-ux-pro-max design engine |
| `.claude/skills/backend-agent/` | Build track: schema, auth, APIs, secure by default |
| `.claude/skills/security-agent/` | Build track: continuous security review, blocking criticals |
| `.claude/skills/inspector/` | Phase 5: spec compliance, code review (confidence ≥ 80), perf pass, PASS/FAIL loop |
| `.claude/skills/ui-ux-pro-max/` | Bundled design intelligence engine (styles, palettes, typography, UX rules, 22 stacks) |
| `.claude/skills/react-best-practices/` | Bundled Vercel React/Next.js performance rules (70 rules) |
| `.claude/skills/git-workflow/` | Git standard: branching, Conventional Commits, merge-on-PASS, recovery recipes |
| `install.sh` | Safe installer for existing projects: no-overwrite merge, CLAUDE.md append, one revertible commit |
| `specs/` | Where briefs, specs, plans, inspection reports, and backlog accumulate |

## Credits

Skills distilled and bundled from four upstream repos:

- **ui-ux-pro-max** (MIT) — bundled whole as `.claude/skills/ui-ux-pro-max/`.
- **Vercel's agent-skills** (MIT) — `react-best-practices` bundled whole.
- **Jeffallan's claude-skills** (MIT) — feature-forge, spec-miner, architecture-designer, api-designer, fullstack-guardian, secure-code-guardian, security-reviewer, code-reviewer, test-master, distilled into the phase skills.
- **Anthropic's claude-code plugins** (feature-dev, code-review) — **not** open source; © Anthropic PBC, use subject to Anthropic's Commercial Terms. Nothing is redistributed from them; only the workflow shape informed this template.

Full license texts and per-source detail: `THIRD-PARTY-NOTICES.md`. Original repos are in the Developer Tree Skills folder.
