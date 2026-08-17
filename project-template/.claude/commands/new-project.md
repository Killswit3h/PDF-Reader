---
description: Run the full build pipeline to create a new app from an idea
argument-hint: Describe what you want to build
---

# New Project Pipeline

The user wants to build from scratch: $ARGUMENTS

Run the complete build pipeline. Announce each phase as you enter it and keep a todo list of the phases so progress is visible.

```
Deep Researcher → Spec Designer → Developer Project Manager
                → [ Frontend Agent | Backend Agent | Security Agent ]
                → Inspector → Final Product
```

## Phase 1 - Research
Invoke the **deep-researcher** skill. Clarify the idea with the user, research prior art and building blocks, produce `specs/01-research-brief.md`.

## Phase 2 - Specification
Invoke the **spec-designer** skill. Resolve open questions with the user, produce `specs/02-spec.md`.

**CHECKPOINT: present the spec summary and get explicit user approval before continuing.** This is the user's main steering moment; everything after this is checked against the spec.

## Phase 3 - Architecture and planning
Invoke the **dev-project-manager** skill. Choose the stack (confirm with the user), design architecture and the integration contract, produce `specs/03-build-plan.md`.

**CHECKPOINT: present stack choice and build plan summary; get approval.** After this approval, build autonomously without further questions unless the spec is silent on something user-visible.

## Phase 4 - Build
Still under dev-project-manager coordination, following the **git-workflow** skill throughout:
1. Scaffold the project, then `git init`, write `.gitignore` and `.env.example`, and make the `chore: scaffold project` commit before any feature code. Commit the approved specs (`docs: add research brief, spec, and build plan`). Then run the **backend-agent** work order (schema, auth, endpoints).
2. Run the **frontend-agent** work order (design system via ui-ux-pro-max first, then UI against the contract).
3. Run the **security-agent** review as code lands; route findings back as fix tasks. Critical findings block progress until fixed.

Commit each completed work-order task with a Conventional Commit referencing its FR numbers (see git-workflow). The tree stays clean between tasks.

Where the environment supports subagents (Task tool), the frontend and backend work orders may run as parallel subagents once the integration contract is fixed; otherwise run them sequentially in the order above.

## Phase 5 - Inspection
Invoke the **inspector** skill against the finished build. On FAIL, dev-project-manager works the punch list and re-inspection loops until PASS.

## Phase 6 - Delivery
Make the final commit, tag `v1.0.0`, and push to the user's remote if one is configured (offer to create a GitHub repo if not). Then summarize for the user: what was built, how to run it, key decisions, contents of `specs/backlog.md` (ideas deferred), and suggested next steps. Do not deploy unless asked.
