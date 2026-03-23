# codebase-intel

Health-aware codebase intelligence for LLM coding agents.

Maps repository structure, tracks import health, and injects a factual summary into Claude Code sessions — so the model starts oriented, not guessing.

## Install

```bash
npm install && npm link
codebase-intel --help
```

## Use

```bash
cd /path/to/project
codebase-intel init          # wire hooks + create state dir
codebase-intel scan          # index files, build graph
codebase-intel watch         # live updates with dashboard
```

Claude Code receives codebase intelligence automatically via hooks.

## Commands

| Command | What it does |
|---------|-------------|
| `init` | Create `.planning/intel/`, wire Claude hooks |
| `scan [--force]` | Index imports/exports, build dependency graph |
| `rescan [--force]` | Scan + prune deleted files |
| `watch` | Live file watching with terminal dashboard |
| `health` | Resolution %, index age, top unresolved |
| `doctor` | Visual diagnostic with trends and hints |
| `summary` | Print what Claude sees |
| `retrieve <query>` | Ranked search with graph context |

## How it works

1. **Extract** — parse imports/exports from JS/TS (regex) and Python (AST)
2. **Resolve** — map import specifiers to file paths (relative, tsconfig, workspace, Python dot-notation)
3. **Graph** — store dependency edges in SQLite, compute fan-in/hotspots
4. **Summarize** — generate bounded markdown (<2200 chars): health, hotspots, entry points, recent changes
5. **Inject** — push summary into Claude Code at session start and on change
6. **Retrieve** — two-phase rg search (source files first), score with definition-site priority, rerank with graph

## Scoring pipeline

Retrieval combines text search with structural reranking:

- **Source-first collection**: rg searches source files before docs/config, preventing changelog saturation
- **Definition-site priority** (+25%): boosts function/class definitions matching the query
- **Exact symbol match** (+40%): strong boost when a definition line's symbol name matches the query exactly
- **Fan-in suppression**: halves graph boost on hub files when a definition match exists elsewhere
- **Penalties**: test (-25%), vendor (-50%), doc/changelog (-40%)
- **Health gating**: graph boosts disabled below 90% import resolution

## Languages

- JavaScript / TypeScript (regex extraction)
- Python (AST extraction via stdlib `ast`)

## Cross-project validation

Tested against Express (142 files), Flask (83 files), React (4,337 files):

| Metric | Score |
|--------|-------|
| MRR | 0.935 |
| nDCG | 0.969 |
| Import resolution | 96–100% |

## Config

Optional `.codebase-intel.json` at repo root:

```json
{
  "globs": ["**/*.{js,ts,py}"],
  "ignore": ["legacy/**"],
  "summaryThrottleMs": 5000
}
```

## State

All state in `.planning/intel/` (never commit):

```
graph.db              SQLite dependency graph
index.json            file metadata + import/export records
summary.md            injected summary
history.json          health trend snapshots
.last_injected_hash.* per-session dedupe
```
