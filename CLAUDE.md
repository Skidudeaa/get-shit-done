# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`codebase-intel` is a health-aware codebase intelligence service that keeps LLM coding agents oriented by continuously mapping repository structure and injecting factual summaries into Claude Code sessions. It solves orientation failures (hallucinated structure, wrong starting files, missed blast radius) by providing a small, honest map before the first prompt and keeping it fresh mid-session.

It is **not** a semantic code understanding engine, LSP, vector database, or IDE replacement. See `DESIGN_PHILOSOPHY.md` for the guiding principles (orientation > intelligence, drift must be loud, degrade don't guess).

## Commands

```bash
npm install          # install dependencies (chokidar, fast-glob, sql.js)
npm link             # make `codebase-intel` globally available
npm test             # runs scripts/test-refresh.sh (refresh hook regression tests)
./test/test-refresh.sh  # alternate path for the same tests
```

There is no build step. CommonJS throughout, no transpilation.

## Architecture

### Data Flow

1. **Extractors** (`lib/extractors/`) parse imports/exports from source files
   - JS/TS: regex-based (`javascript.js`)
   - Python: shells to `python_ast.py` for AST-based extraction (`python.js`)
   - Registry pattern: `extractors/index.js` maps extensions to extractors

2. **Resolver** (`lib/resolver.js`) resolves import specifiers to file paths
   - JS/TS: relative paths, tsconfig `paths`/`baseUrl`, workspace packages
   - Python: relative imports (dot notation), local package imports
   - Returns `{ specifier, resolved, kind }` where kind is `relative|external|tsconfig|workspace|asset|unresolved`

3. **Graph** (`lib/graph.js`) stores the dependency graph in SQLite (via sql.js, in-memory + disk persistence)
   - Tables: `files`, `imports`, `exports`, `meta`
   - Provides fan-in/fan-out queries, neighbor expansion, hotspot detection

4. **Intel** (`lib/intel.js`) orchestrates everything — the central module (highest fan-in)
   - Per-root state management via `stateByRoot` Map
   - Serialized operations via `withQueue()` promise chain
   - Debounced flushing for index, graph, and summary writes

5. **Summary** (`lib/summary.js`) generates bounded markdown summaries (clamped to ~2200 chars)
   - Includes: health metrics, module types, dependency hotspots, entry points, recent git changes
   - Emits `ALERT:` lines when resolution < 90% or index is stale

6. **Retrieve** (`lib/retrieve.js`) provides ranked search combining text search with graph reranking
   - Backends: rg (default) or Zoekt (optional, auto-detected)
   - Reranking: entry point boost, hotspot/fan-in boost, test/vendor penalties, symbol-aware scoring
   - Graph boosts are gated when resolution < 90%

### Injection into Claude Code

Two hooks wire the system into Claude Code sessions (configured in `.claude/settings.json`):
- **SessionStart**: `codebase-intel hook sessionstart` — injects summary on session start/resume
- **UserPromptSubmit**: `node tools/codebase_intel/refresh.js` — re-injects if summary changed (per-session dedupe via SHA-256 hash files)

Both emit under the same `<codebase-intelligence>` XML tag.

### Watch Mode

`watch.js` uses chokidar to watch for file changes, calling `intel.updateFile()` with debounced index/graph/summary flushes. Renders a live terminal dashboard when TTY is available.

### Per-Repo State

All state lives in `.planning/intel/` (never committed):
- `graph.db` — SQLite dependency graph
- `index.json` — file metadata and import/export records
- `summary.md` — the injected summary
- `history.json` — health snapshots for sparkline trends
- `.last_injected_hash.*` — per-session dedupe hashes

## Key Design Decisions

- **Health-gated ranking**: Graph-based reranking (fan-in boosts, hotspot detection) is disabled when import resolution drops below 90%. This prevents bad graph data from amplifying wrong results.
- **Debounced writes**: Index, graph, and summary writes use independent debounce timers to batch rapid file changes during watch mode.
- **Queue serialization**: All operations on a root are serialized through a promise chain (`withQueue`) to prevent concurrent SQLite access.
- **Scope context**: `scope-finder.js` provides function/class-level context for search hits. Python uses AST (via `python_ast.py`), JS/TS uses heuristic brace-pairing with comment/string/regex masking.
- **Summary is clamped**: Output is hard-capped at ~2200 chars to stay within useful context budget.
- **Per-repo config**: `.codebase-intel.json` at repo root overrides default globs, ignore patterns, and summary throttle interval.
