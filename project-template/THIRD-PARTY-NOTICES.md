# Third-Party Notices

This template bundles or adapts material from the projects below. Each entry names
what was taken, under which license, and reproduces the license text where the
upstream project supplies one.

---

## 1. ui-ux-pro-max

**Bundled whole** as `.claude/skills/ui-ux-pro-max/` — the `SKILL.md`, the Python
search engine under `scripts/`, the CSV corpora under `data/`, and the `references/`
documents.

License: **MIT**

```
MIT License

Copyright (c) 2024 Next Level Builder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Local modification: the `Stacks:` list in `scripts/search.py`'s module docstring was
corrected to name all 22 stacks that ship in `data/stacks/`.

---

## 2. Vercel — agent-skills

**Bundled** as `.claude/skills/react-best-practices/` — the `SKILL.md` and all 70
rule files under `rules/`.

License: **MIT**, per the upstream repository's `README.md` ("## License — MIT") and
the `"license": "MIT"` field in `packages/react-best-practices-build/package.json`.
The upstream repository ships no `LICENSE` file, so no copyright line is reproduced
here; the standard MIT terms above apply.

---

## 3. Jeffallan — claude-skills

**Distilled, not copied.** The `spec-designer`, `dev-project-manager`, `backend-agent`,
`security-agent`, and `inspector` skills draw on the structure and checklists of
feature-forge, spec-miner, architecture-designer, api-designer, fullstack-guardian,
secure-code-guardian, security-reviewer, code-reviewer, and test-master. The prose in
this template was rewritten; some reference documents under
`.claude/skills/backend-agent/references/` and `.claude/skills/spec-designer/references/`
retain substantial upstream structure.

License: **MIT**

```
MIT License

Copyright (c) 2025

[Full MIT terms as reproduced in section 1 above.]
```

---

## 4. Anthropic — claude-code plugins

**Distilled, not copied.** The phase-gate shape of the pipeline and the
confidence-threshold review filter in `inspector` draw on the feature-dev and
code-review plugins.

License: **NOT open source.** The upstream repository states:

> © Anthropic PBC. All rights reserved. Use is subject to Anthropic's
> [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

No Anthropic code or text is redistributed in this template — only independently
written prose informed by the same workflow ideas. If any verbatim Anthropic material
is later added here, it must be removed or separately licensed, since the Commercial
Terms do not grant redistribution rights the way MIT does.

---

## Scope of these notices

These notices cover the contents of `project-template/` only. They do not apply to the
host application in the rest of this repository, which carries its own license.
