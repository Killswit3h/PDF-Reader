---
description: Run the build pipeline to add a feature to the existing project
argument-hint: Describe the feature you want to add
---

# New Feature Pipeline

The user wants to add to this existing project: $ARGUMENTS

Run the build pipeline scoped to a feature. Announce each phase and keep a todo list of the phases. The prime directive for feature work: **do not break what already works.** Existing conventions win over personal preference in every phase.

```
Deep Researcher → Spec Designer → Developer Project Manager
                → [ Frontend Agent | Backend Agent | Security Agent ]
                → Inspector → Added Feature
```

## Phase 1 - Research (codebase first)
Invoke the **deep-researcher** skill. For a feature, the codebase exploration step is mandatory: detect the stack, trace how similar existing features are built, identify the exact integration points and files that will be touched. Then research externally only what the feature needs. Produce `specs/01-research-brief.md` (use a feature-specific name like `specs/feature-<slug>-brief.md` if specs/ already has pipeline files from a previous run).

## Phase 2 - Specification
Invoke the **spec-designer** skill. Scope hard: what changes, what explicitly must not change (regression boundary). Produce the spec file.

**CHECKPOINT: user approves the spec before any code.**

## Phase 3 - Planning
Invoke the **dev-project-manager** skill. No stack decision needed; the plan must follow existing conventions. The integration contract covers new/changed routes and types, plus a list of existing behaviors that must still pass after the change. Produce the build plan.

**CHECKPOINT: user approves the plan. Then build autonomously.**

## Phase 4 - Build
Under dev-project-manager coordination: **backend-agent** for schema/endpoint changes (migrations must be backward-safe), **frontend-agent** for UI (reuse the existing design system; read `design-system/*/MASTER.md` if present rather than generating a new one), **security-agent** reviewing as code lands, with special attention to the new surface area's auth.

## Phase 5 - Inspection
Invoke the **inspector** skill. In addition to the standard checks, verify the regression boundary: exercise the neighboring existing features listed in the plan and confirm they still behave. Loop the punch list until PASS.

## Phase 6 - Delivery
Summarize: what changed, files touched, how to try the feature, anything deferred to `specs/backlog.md`.
