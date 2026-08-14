# Build Pipeline

This project uses a structured multi-agent build pipeline. When the user asks to build a new app or product from scratch, run the `/new-project` command workflow. When the user asks to add or change a feature in this project, run the `/new-feature` command workflow. If the user describes something buildable without naming a command (for example "I want an app that..." or "add a page where..."), ask one question: new project or feature for this repo, then run the matching pipeline.

## Pipeline order

```
Deep Researcher → Spec Designer → Developer Project Manager
                → [ Frontend Agent | Backend Agent | Security Agent ]
                → Inspector → Final Product / Added Feature
```

Each role is a skill in `.claude/skills/`:

| Phase | Skill | Output |
|-------|-------|--------|
| 1. Research | `deep-researcher` | `specs/01-research-brief.md` |
| 2. Specification | `spec-designer` | `specs/02-spec.md` (user approves) |
| 3. Architecture & plan | `dev-project-manager` | `specs/03-build-plan.md` (user approves) |
| 4. Build | `frontend-agent`, `backend-agent`, `security-agent` | the code |
| 5. Verification | `inspector` | `specs/04-inspection-report.md`, loop to PASS |

Support libraries (used by the roles, not phases themselves):
- `.claude/skills/ui-ux-pro-max/` - searchable design intelligence engine (design systems, styles, palettes, typography, UX rules, stack guidance). The frontend-agent drives it.
- `.claude/skills/react-best-practices/` - Vercel's React/Next.js performance rules. Used by frontend-agent while building and inspector while reviewing.

## Ground rules

- Never skip phases. Small task? The phases just get short, not skipped.
- The spec is the contract. Code that conflicts with the spec is wrong; spec changes go through the user.
- Two user checkpoints: spec approval and plan approval. After plan approval, build without further questions unless the spec is silent on something user-visible.
- Pipeline artifacts live in `specs/`. Deferred ideas go to `specs/backlog.md` instead of expanding scope mid-build.
- Security is a build track, not an afterthought. Critical security findings block delivery.
