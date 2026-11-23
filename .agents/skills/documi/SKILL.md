---
name: documi
description: Read, update, and verify Living Specifications managed by Documi via MCP and CLI. Use before implementing features, changing behavior/API/architecture, reviewing specs, or syncing code and tests with specifications.
---

# Documi Living Specification Workflow

This repository manages its Living Specifications in `docs/` using **Documi**.
Prefer the Documi MCP server (`documi mcp --project .`) over reading raw spec files one by one so context stays minimal and structured.

## 1. Progressive Disclosure (Read Before Coding)

1. Call `get_project_map` first to load Goals, Architecture summaries, Decision `<Outcome>` blocks, Domain Terms, and overall Review / Realization status.
2. Call `query_specs` to find relevant `<Spec>` blocks by intent, stability, realization status, or tag.
3. Call `get_spec_context` for each target Spec ID to retrieve its upstream Goal, unresolved human feedback, related Design/Contract docs, referenced Terms, and `<SourceRef>` anchors.
4. Only call `get_document` or `search_documents` when full surrounding prose is needed.

## 2. Surgical Editing via MCP (Keep Diffs Minimal)

When updating specifications, prefer Documi's AST-aware MCP editing tools over rewriting whole MDX files:

- `update_block` — replace the body or attributes of an existing `<Spec>` / `<Constraint>` / `<Outcome>` / `<Note>` / `<TermDef>`.
- `add_block` — append a new semantic block to an existing document.
- `upsert_term` — add or update a `<TermDef>` (with `aliases` and `symbols="src/...#Symbol"`) in the glossary.
- `scaffold_document` — create a new typed document (`goal`, `decision`, `domain`, `spec`, `contract`, `architecture`, `design`, `verification`, `guide`) with valid frontmatter.
- `rename_block_id` — safely rename a block ID and all cross-references (always preview with `dryRun: true` first).

## 3. Sync Code & Tests With Specs

- Link implementation code to specs with `// @implements <spec.id>` (or `<SourceRef file="src/..." satisfies="<spec.id>" />`).
- Link verification tests with `test('[<spec.id>] ...', ...)` (or `// @verifies <spec.id>`) and emit JUnit XML when running tests if configured.
- Always write `<SourceRef file="...">` and `<TermDef symbols="...">` as POSIX paths relative to the project root.
- Update the relevant specs, contracts, designs, or decisions in the same change whenever behavior, API, or architecture changes.

## 4. Invariant Guardrails

- **Never edit `docs/.documi/reviews.json` directly.** Approvals and feedback belong strictly to humans (enforced by `documi check --no-review-edit`).
- **Never write executable JS inside MDX** (no ESM `import`/`export`, no JSX `{...}` expressions, no unapproved components).
- **Never create temporary `tasks.md` checklists inside `docs/`** — progress is computed automatically from code, tests, and PRs.

## 5. Verify Before Finishing

1. Call MCP `validate_docs` (or run `documi check --no-review-edit`) and confirm 0 errors (Rooted DAG, MDX safety, AST symbol references).
2. Summarize any new or modified Spec IDs so the human reviewer can inspect and approve them in the Documi Web UI (`documi serve`).
