# codebase-intel — Developer Notes

This document is for **maintaining and operating** the system, not explaining it.

---

## Architecture (mental model)

- **Global CLI**: one binary (`codebase-intel`) installed once
- **Per-repo state**: `.planning/intel/`
- **Watcher**: keeps state fresh
- **Hooks**:
  - SessionStart → baseline injection
  - UserPromptSubmit → refresh if changed (per-session dedupe)

No background magic. Everything is explicit.

---

## Repo layout (core)

```
bin/
  intel.js          # CLI entrypoint
lib/
  intel.js          # orchestration (init/scan/update/health)
  summary.js        # bounded summary + alerts
  retrieve.js       # search + graph + rerank
  resolver.js       # local import resolution
  graph.js          # SQLite helpers
  extractors/
    javascript.js   # JS/TS extractor
    python_ast.py   # Python AST extractor
    python.js       # Node wrapper
scripts/
  setup.sh          # one-command project setup
test/
  test-refresh.sh   # refresh hook regression tests
```

---

## Per-repo state (never commit)

```
.planning/intel/
  graph.db
  index.json
  summary.md
  .last_injected_hash.*
```

Add `.planning/` to `.gitignore`.

---

## Live refresh (important)

Live refresh requires **both**:

1. Watcher running:
   ```bash
   codebase-intel watch --summary-every 5
   ```

2. Hooks wired (done by `init`):
   - SessionStart
   - UserPromptSubmit

Refresh is:
- deduped per session
- emitted only when summary content changes
- injected under the same `<codebase-intelligence>` tag

---

## Health semantics

- Resolution ≥ 95% → healthy
- 90–94% → watch it
- < 90% → graph boosts are gated
- Large index age → watcher not running

Health is advisory but enforced in ranking.

---

## Python specifics (intentionally limited)

**Parsing**: stdlib AST (correct syntax handling)

**Resolution**:
- relative imports
- local package imports

**Not supported**:
- venv / sys.path
- namespace packages
- runtime discovery

This is by design. Do not fake correctness.

---

## When to rescan

- after large refactors
- after mass renames
- if health looks wrong

```bash
codebase-intel scan
```

---

## Things NOT to add casually

- Embeddings
- LLM calls
- Semantic claims (LSP-like behavior)
- Multi-language explosion
- Huge summaries

Use health metrics to justify changes.

---

## Release discipline

- Tag releases
- Keep JSON contracts stable
- Prefer additive changes

---

## Deploying to a new project

```bash
cd /path/to/project
/path/to/codebase-intel/scripts/setup.sh
```

The script:
1. Checks `codebase-intel` is on PATH
2. Runs `init` + `scan`
3. Shows `doctor` output
4. Adds `.planning/` to `.gitignore`
5. Prints watcher command

---

## Doctor command

```bash
codebase-intel doctor
```

Outputs:
- State file checks (graph.db, index.json, summary.md, hooks)
- Health metrics (resolution %, index age)
- Top unresolved imports
- Active config globs
- Search backend availability (rg, zoekt)
- Actionable hints

This is the first command to run when "something feels off".

---

## Debugging

```bash
codebase-intel doctor                    # full diagnosis
codebase-intel health                    # raw metrics (JSON)
codebase-intel summary                   # see what Claude receives
ls -la .planning/intel/.last_injected_hash.*  # session hashes
./test/test-refresh.sh                   # run regression tests
```
