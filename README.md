# Documi

**English** | [日本語](./README.ja.md)

A **Living Specification platform** for AI-assisted engineering: specs that humans can read and trace straight to code, and AI agents can faithfully reproduce without drifting into disposable `tasks.md` files.

Markdown / MDX + YAML Frontmatter in Git is the Single Source of Truth. Web UI, REST API, MCP Server, and CLI all share one framework-agnostic Document Core (`src/core/`).

---

## 5-Minute Quickstart (Start Small)

You don't need all 9 artifact types on day one. Start with just **3 core types** (`goal`, `spec`, `decision`) + `<SourceRef>` + `documi check`:

### 1. Run Documi from source (pre-release)

```bash
git clone https://github.com/naatin777/documi.git
cd documi
bun install
bun run build
```

### 2. Initialize a project

```bash
bun src/cli.ts init --project /path/to/your-repo
# Add --ja for Japanese templates and Agent Skills
```

This creates a minimal `docs/` starter and installs 4 standard Agent Skills under `.agents/skills/` without touching your existing `AGENTS.md`.

### 3. Write one `<Spec>` and link it to code

```mdx
---
type: spec
title: Account Lockout
derives: [goals/security]
---

<Spec id="auth.lockout" stability="stable">
  **When** login fails 5 times consecutively, **the** Auth Service **shall** lock the account for 15 minutes.
</Spec>

<SourceRef file="src/auth.ts" symbol="lockAccount" satisfies="auth.lockout" />
```

In code & tests:

```ts
// @implements auth.lockout
export function lockAccount() { /* ... */ }

test('[auth.lockout] locks account after 5 failures', () => { /* ... */ })
```

### 4. Validate and explore

```bash
bun src/cli.ts check --project /path/to/your-repo       # Validate DAG, MDX safety, AST symbols, test realization
bun src/cli.ts serve --project /path/to/your-repo       # Start Web UI + REST API + HTTP MCP at http://127.0.0.1:3000
```

---

## Why Documi?

- **Solves Day-2 Spec Rot**: Instead of disposable `plan.md` / `tasks.md`, specs live in Git and stay linked to real AST symbols (`@ast-grep/napi`), `@implements` anchors, and JUnit XML test results (`realization`: `unimplemented` → `in-progress` → `implemented` → `verified` / `drifted`).
- **Convergent AI Reviews**: Records architectural decisions (`<Outcome>`) and Non-Goals in a Rooted DAG so AI agents stop re-litigating settled design choices.
- **Dual AI Interface (Zero Lock-In)**: Use **CLI + Agent Skills** (works with any coding agent, no MCP setup required) or **MCP Server** (14 tools over stdio `documi mcp` or HTTP `/mcp`) — both powered by the same core.
- **Human-Only Approval Guard (`docs/guard/reviews.json`)**: Keeps human approvals physically separate from MDX prose, computes line diffs on edit (`stale`), surfaces lightweight upstream change notices (`suspect`), and blocks AI edits via `documi check --no-review-edit`.
- **Safe Static MDX**: Renders semantic tags (`<Spec>`, `<Constraint>`, `<Outcome>`, `<Note>`, `<TermDef>`, `<Term>`, `<SourceRef>`) plus Mermaid, KaTeX, and Shiki through a static mdast pipeline — arbitrary JS/ESM execution is strictly forbidden.
- **Zero-Dependency Search + Optional Local Hybrid RAG**: Built-in Japanese (`Intl.Segmenter`) / English / code-identifier BM25 + glossary synonym expansion + graph expansion (`documi search --context`), plus optional Ollama / OpenAI-compatible HTTP embeddings cached in `bun:sqlite`.
- **Read-Only Static Site & Bundle Export**: Export a provider-agnostic static site (`documi build-site`) for Cloudflare Pages / GitHub Pages / Vercel / S3, or bundle multiple docs into a single HTML/PDF (`documi export`).

---

## Core CLI Commands

Run `documi <command> --help` for per-command options. All read & edit commands support `--json`.

| Command | Purpose |
|---|---|
| `documi init` | Scaffold `docs/` and `.agents/skills/` (`--en` default, `--ja` optional) |
| `documi serve` | Start Web UI, REST API, and HTTP MCP server with live reload |
| `documi mcp` | Start MCP server over stdio |
| `documi check` | Validate DAG, MDX safety, AST `<SourceRef>`/`<TermDef>`, JUnit realization, and `--no-review-edit` |
| `documi map` / `list` / `show` / `relations` | Inspect project overview, documents, and traceability links |
| `documi search` / `retrieve` / `query` / `context` | Search specs & assemble graph-aware context within a token budget |
| `documi block add\|update\|rename` / `term upsert` / `scaffold` | AST-positioned surgical edits with immediate validation |
| `documi approve` / `unapprove` | Human-only approval management (`docs/guard/reviews.json`) |
| `documi build-site` / `export` | Build a read-only static site or export a combined HTML/PDF bundle |

---

## MCP Server (14 Tools)

Connect via stdio (`documi mcp --project .`) or Streamable HTTP (`http://127.0.0.1:3000/mcp`):

- **Read & Search**: `get_project_map`, `list_documents`, `get_document`, `get_relations`, `get_impact`, `query_specs`, `get_spec_context`, `search_documents` (`includeContext`), `validate_docs`
- **Surgical Edit**: `add_block`, `update_block`, `rename_block_id`, `upsert_term`, `scaffold_document`

---

## Development (Contributing to Documi)

Requires **Bun >= 1.4.0**.

```bash
bun install
bun run dev           # Vite (5173) + Hono (3000, auto-watch & SSE reload)
bun run build         # Build frontend into dist/
bun run test          # Run test suite
bun run check         # Typecheck
bun run lint          # oxlint --type-aware --deny-warnings
bun run format:check  # oxfmt --check
bun run knip          # Unused files & exports check
bun run documi:check  # Dogfooding living spec check on docs/
```

Releases are triggered exclusively by pushing a version tag (`v*.*.*`) via `.github/workflows/release.yml`.

## License

[MIT](./LICENSE)
