# Retrieval Evaluation Findings

## What We Built

A self-referential evaluation harness (`scripts/eval-retrieve.js`) that runs 19 queries against the codebase-intel index and measures retrieval quality. Each query runs twice — with and without graph boosts — to isolate the graph's effect on ranking.

**Run it:**
```bash
node scripts/eval-retrieve.js            # terminal output
node scripts/eval-retrieve.js --verbose  # show hit lines and scoring signals
node scripts/eval-retrieve.js --json     # machine-readable for CI
```

---

## Bug Found: Silent Graph Boost Failure

The harness immediately exposed a path normalization bug in `lib/retrieve.js`. rg returns paths with a `./` prefix (`./lib/retrieve.js`) but the graph DB stores bare relative paths (`lib/retrieve.js`). Every `fanInByPaths` and `fileMetaByPaths` query silently returned empty results, meaning **graph boosts (hotspot, fan-in) never fired for any rg-backed query**.

Fixed in `c578e94` by normalizing hit paths before graph lookups.

---

## Scoring Evolution

### v1 Baseline (post path-normalization fix, c578e94)

| Metric           | Score  |
|------------------|--------|
| Mean P@k         | 0.756  |
| Mean MRR         | 0.838  |
| Mean nDCG        | 0.920  |
| Mean Usefulness  | 0.921  |
| Graph Lift P@k   | +0.011 |
| Graph Lift nDCG  | -0.044 |

19 cases across 7 categories: symbol lookup, multi-word, path, cross-file, scoring, scope, negative.

### v1 Key Finding: Graph Boosts Help Breadth, Hurt Definitions

Graph boosts improved precision (pulling relevant files into the top-k) but degraded ranking (pushing hub files above definition files). Root cause: fan-in didn't distinguish a file that **defines** a symbol from one that merely **imports** it. `intel.js` imports nearly everything, so it accumulated the highest fan-in and was promoted above actual definition files.

### v2 Fixes Applied (bb18522, dbb9348)

Three-pronged fix:

1. **`exact_symbol` weight raised +25% → +40%** (`scoring.js`). The original +25% was too weak to overcome fan-in promotion on hub files.
2. **Definition-site priority signal +25%** (`retrieve.js`). Fires when a hit line is a function/class definition AND the query matches the symbol name. Tags hits with `_hasDefSiteMatch` for use in the suppression pass.
3. **Fan-in suppression pass** (`retrieve.js`). After initial scoring, if any hit has a definition-site match, the fan-in/hotspot boost is halved for hits in files without such a match. Prevents `intel.js` from outranking definition files.
4. **File sort: bestAdjustedHitScore promoted to primary key** (`retrieve.js`). The linchpin fix — `rerankFiles` previously sorted by raw fan-in before adjusted scores, so all hit-level scoring signals were ignored at the file level. Now sorts by `bestAdjustedHitScore` first, with fan-in as a tiebreaker.

### v2 Results (post-fix)

| Metric           | v1     | v2     | Delta   |
|------------------|--------|--------|---------|
| Mean P@k         | 0.756  | 0.746  | -0.010  |
| Mean MRR         | 0.838  | **0.931** | **+0.093** |
| Mean nDCG        | 0.920  | **0.966** | **+0.046** |
| Mean Usefulness  | 0.921  | **0.934** | +0.013  |
| Graph Lift P@k   | +0.011 | +0.011 | 0.000   |
| Graph Lift nDCG  | -0.044 | **0.001** | **+0.045** |

**Graph boosts are no longer harmful.** nDCG lift went from -0.044 to neutral.

### Cases fixed by v2

| Case | v1 Rank | v2 Rank | MRR Change |
|------|---------|---------|------------|
| `sym-002` "computeEnhancedSignals" | 1.retrieve.js 2.scoring.js | **1.scoring.js** 2.retrieve.js | 0.5 → 1.0 |
| `sym-005` "extractSymbolDef" | 1.scoring.js (no regression) | **1.scoring.js** (stayed correct) | 1.0 → 1.0 |
| `path-001` "resolveImport" | 1.intel.js 2.resolver.js | **1.resolver.js** 2.intel.js | 0.5 → 1.0 |
| `path-002` "writeSummaryMarkdown" | 1.intel.js 2.summary.js | **1.summary.js** 2.intel.js | 0.5 → 1.0 |

---

## Harness Design

### Metrics
- **P@k**: Fraction of top-k results that are relevant, using `min(k, |retrieved|)` as denominator
- **MRR**: Reciprocal rank of the primary relevant file (capped at rank 10)
- **nDCG**: Rank-ordering quality with graded relevance (primary=2, secondary=1, acceptable=0.5)
- **Usefulness**: Composite of file rank (0.30), hit quality (0.30), precision (0.20), related expansion (0.20)
- **Graph Lift**: Delta between graph-on and graph-off runs, measured on both P@k and nDCG

### Three-tier relevance
- `relevantFiles` (gain=1.0): The correct answer
- `acceptableFiles` (gain=0.5): Useful but not ideal (consumers, re-exports, related modules)
- Everything else (gain=0.0): Noise

### Noise filtering
The eval dataset and harness script contain query terms (self-referential). Results from `eval-dataset.json`, `eval-retrieve.js`, and `rawCode*.md` are filtered before scoring.

### Graph isolation
- Graph ON: `rerankMinResolutionPct: 0` — forces boosts regardless of resolution
- Graph OFF: `rerankMinResolutionPct: 101` — guarantees boosts are disabled

---

## What To Fix Next

### Import Resolution Gap

The tool currently resolves ~54% of local imports on real repos (history.json shows 31/57). This is below the 90% health gate, meaning graph boosts are disabled in practice. Root causes identified:

1. **Old index format entries** (~9 imports) — files indexed with absolute path keys and plain-string import arrays lack resolution data. A full re-index fixes these immediately.
2. **Regex extraction limitations** — template string imports (`require(\`./\${name}\`)`) and computed specifiers are silently missed by the JS extractor.
3. **Python namespace packages** — resolver checks for `__init__.py` but PEP 420 namespace packages don't require it.

**Quick win**: delete `.planning/intel/index.json` and re-scan to fix the format-based unresolved imports (~11% resolution improvement for free).

### Remaining Scoring Opportunities

- **P@k** dropped slightly (0.756 → 0.746) — worth investigating whether any relevant files are being pushed out of top-k
- `cross-003` "extractImports" has MRR 0.500 because `index.js` (entry point boost) outranks the definition files. Consider whether entry point should yield to definition-site matches.
- `multi-003` "resolutionPct" has MRR 0.250 — this is a variable (not a definition) spread across many files, so the current scoring is reasonable.
