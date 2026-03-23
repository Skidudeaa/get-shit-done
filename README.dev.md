# Developer Notes

For maintaining and operating the system.

## Layout

```
bin/intel.js              CLI entrypoint
lib/
  intel.js                orchestration (init/scan/update/health/auto-migrate)
  retrieve.js             search + scoring + graph rerank
  scoring.js              symbol detection, noise penalty, enhanced signals
  resolver.js             import → file path resolution
  graph.js                SQLite dependency graph
  summary.js              bounded summary generation + health alerts
  rg.js                   ripgrep backend (source-first two-phase collection)
  scope-finder.js         function/class scope context for hits
  zoekt.js                Zoekt backend (optional)
  extractors/
    javascript.js         JS/TS regex extractor
    python_ast.py          Python AST extractor
    python.js             Node wrapper for python_ast.py
scripts/
  eval-retrieve.js        retrieval evaluation harness (19 cases)
  eval-dataset.json       eval test cases
  setup.sh                one-command project deployment
  test-refresh.sh         refresh hook regression tests
```

## Hooks

Wired into `.claude/settings.json` by `init`:

- **SessionStart**: injects summary on session start/resume
- **UserPromptSubmit**: re-injects if summary changed (per-session SHA-256 dedupe)

Both emit under `<codebase-intelligence>` XML tag.

## Health semantics

- Resolution >= 90%: graph boosts enabled
- Resolution < 90%: graph boosts gated (degrade, don't guess)
- Large index age: watcher not running

## Index auto-migration

`INDEX_VERSION` tracks format changes. On load, `migrateIndexIfNeeded()`:
- Normalizes absolute-path keys to relative
- Clears stale string imports
- Triggers immediate re-extraction of affected files
- No manual rescan needed

## Scoring signals (in order of strength)

| Signal | Weight | Where |
|--------|--------|-------|
| `exact_symbol` | +40% | scoring.js — definition line symbol matches query |
| `def_site_priority` | +25% | retrieve.js — definition line + query match |
| `hotspot` | +15% | retrieve.js — file in top-5 fan-in |
| `symbol_contains_query` | +12% | scoring.js — symbol name contains query term |
| `export_match` | +10% | scoring.js — export statement with query term |
| `entrypoint` | +10% | retrieve.js — file matches entry point pattern |
| `python_public` | +8% | scoring.js — public Python symbol |
| `docstring_match` | +5% | scoring.js — Python docstring/comment |
| `exportline` | +5% | retrieve.js — generic export line |
| `defline` | +3% | retrieve.js — generic definition line |
| `fanin` | +1–4% | retrieve.js — logarithmic fan-in boost |
| `doc` | -40% | retrieve.js — markdown/rst/changelog files |
| `test` | -25% | retrieve.js — test directory/file |
| `noise_ratio` | -8–15% | scoring.js — high keyword noise ratio |
| `vendor` | -50% | retrieve.js — node_modules/dist/build |
| `fanin_suppressed` | varies | retrieve.js — halves graph boost when def match exists |

## rg two-phase collection

Phase 1: source files only (`.js`, `.py`, `.go`, `.rs`, etc.) — guarantees definitions reach scorer.
Phase 2: remaining capacity filled with docs/config.

Raw limit inflated to 5x `maxHits` for candidate diversity.

## Eval harness

```bash
node scripts/eval-retrieve.js             # terminal
node scripts/eval-retrieve.js --verbose   # hit details + signals
node scripts/eval-retrieve.js --json      # machine-readable
```

19 cases, 7 categories. Measures P@k, MRR, nDCG, usefulness, graph lift.

## Debugging

```bash
codebase-intel doctor                          # full diagnosis
codebase-intel health                          # raw metrics JSON
codebase-intel summary                         # what Claude receives
node scripts/eval-retrieve.js --verbose        # scoring debug
ls -la .planning/intel/.last_injected_hash.*   # session dedupe state
```

## What not to add

- Embeddings or vector search
- LLM calls in the pipeline
- Semantic claims (LSP-like)
- Summaries > 2200 chars

Use eval metrics to justify changes.
