---
name: documi-bootstrap
description: Bootstrap Documi Living Specifications for an existing (brownfield) codebase. Use when adopting Documi in a repository that already has source code and tests, to inventory architecture, domain terms, and core specifications incrementally.
---

# Documi Brownfield Bootstrap Workflow

Use this skill when introducing Documi into an **existing codebase** so that initial Living Specifications reflect reality without overwhelming the repository with boilerplate.

## 1. Inspect the Existing Repository

1. Map the repository layout: top-level directories, runtime/build manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.), entry points, and existing `README.md` or docs.
2. Check whether `docs/` is already occupied by user-facing documentation (e.g., Docusaurus/VitePress).
   - If `docs/` is occupied, create `.documi.json` at the project root (for example `{ "docs": "documi" }`) so Documi does not collide with existing docs.
3. Identify the 3–5 most critical user-facing or domain capabilities, key domain data structures/types, and existing test suites.

## 2. Establish Top-Down Anchors First (Thin Skeleton)

Use Documi MCP tools (`scaffold_document`, `add_block`, `upsert_term`) rather than hand-crafting large files:

1. **Root Goal (`goals/`)**: Create 1 concise Root Goal describing the product purpose, target users, and explicit Non-Goals. Capture hard architectural invariants as `<Constraint id="...">`.
2. **System Overview (`architecture/`)**: Create 1 high-level architecture document describing modules, boundaries, and data flow with real `<SourceRef file="src/..." />` links.
3. **Existing Key Decisions (`decisions/`)**: Record only the 1–3 most consequential architectural decisions already baked into the codebase, each with a 2–3 line `<Outcome id="dec....">`.

## 3. Extract Bottom-Up Living Specs From Real Code

1. **Domain Glossary (`domain/glossary.mdx`)**: Register the 5–10 core domain concepts via `upsert_term` with `symbols="src/...#Symbol"` pointing to real types/classes/functions in the codebase.
2. **Core Specifications (`specs/`)**: For each critical capability (start small: 3–5 specs, not every helper function):
   - Write EARS-style `<Spec id="domain.capability" stability="evolving" derives="goals/...">` blocks describing the *observable contract* of the existing system.
   - Do not fabricate undocumented behavior; verify against the actual implementation and tests.
   - Add `// @implements <spec.id>` (or `<SourceRef ... satisfies="<spec.id>" />`) and link existing tests where appropriate.
3. **Contracts (`contracts/`)**: If the project exposes HTTP/RPC APIs, CLI commands, or MCP/event schemas, summarize them in a contract document linked via `satisfies`.

## 4. Validate & Hand Off to Humans

1. Run `validate_docs` (MCP) or `documi check` and fix all broken `<SourceRef>` paths, missing `derives` (orphan specs), or invalid MDX syntax.
2. **Do not edit `docs/.documi/reviews.json`.** Leave all bootstrapped specs as `unreviewed` so the human owner can read, refine, and approve them in `documi serve`.
3. Present a concise summary of created documents, Spec IDs, and any ambiguities discovered in the existing codebase that need a human decision.
