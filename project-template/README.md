# Project Template - Structured Build Pipeline

A drop-in folder that gives any coding project a consistent, multi-agent way to build new apps and add features, based on the pipeline:

```
Deep Researcher → Spec Designer → Developer Project Manager
                → [ Frontend Agent | Backend Agent | Security Agent ]
                → Inspector → Final Product / Added Feature
```

## How to install into a project

Copy the **contents** of this folder into the root of your project:

- `.claude/` (skills + commands)
- `CLAUDE.md`
- `specs/` (empty; pipeline outputs land here)
- `docs/pipeline.md` (reference)

New empty project: copy everything as-is. Existing project that already has a `CLAUDE.md`: paste the "Build Pipeline" section of this template's `CLAUDE.md` into yours (or keep both sections in one file). Existing `.claude/` folder: merge the `skills/` and `commands/` subfolders in.

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
| `.claude/skills/react-best-practices/` | Bundled Vercel React/Next.js performance rules (76 rules) |
| `specs/` | Where briefs, specs, plans, inspection reports, and backlog accumulate |

## Credits

Skills distilled and bundled from four open-source repos: Anthropic's claude-code plugins (feature-dev, code-review), Jeffallan's claude-skills (feature-forge, spec-miner, architecture-designer, api-designer, fullstack-guardian, secure-code-guardian, security-reviewer, code-reviewer, test-master; MIT), the ui-ux-pro-max skill (bundled whole), and Vercel's agent-skills (react-best-practices; MIT). See the original repos in the Developer Tree Skills folder for full sources.
