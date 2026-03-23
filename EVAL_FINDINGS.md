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

## Current Baseline (post-fix)

| Metric           | Score  |
|------------------|--------|
| Mean P@k         | 0.802  |
| Mean MRR         | 0.838  |
| Mean nDCG        | 0.920  |
| Mean Usefulness  | 0.930  |
| Graph Lift P@k   | +0.017 |
| Graph Lift nDCG  | -0.044 |

19 cases across 7 categories: symbol lookup, multi-word, path, cross-file, scoring, scope, negative.

---

## Key Finding: Graph Boosts Help Breadth, Hurt Definitions

Graph boosts improve precision (pulling relevant files into the top-k) but degrade ranking (pushing hub files above definition files).

### Where graph boosts help

| Case | Effect |
|------|--------|
| `multi-003` "resolutionPct" | Promotes `intel.js` (fan-in=5) from rank 4 to rank 1. **+0.20 P@k lift.** |
| `cross-003` "extractImports" | Promotes `intel.js` into top-5, displacing `CHANGELOG.md`. **+0.10 P@k lift.** |

### Where graph boosts hurt

| Case | Effect |
|------|--------|
| `sym-002` "computeEnhancedSignals" | `retrieve.js` (fan-in=2) overtakes `scoring.js` where the function is defined. MRR drops 1.0 → 0.5. |
| `path-001` "resolveImport" | `intel.js` (fan-in=5) overtakes `resolver.js` where the function is defined. MRR drops 1.0 → 0.5. |
| `path-002` "writeSummaryMarkdown" | `intel.js` overtakes `summary.js` where the function is defined. MRR drops 1.0 → 0.5. |

**Net nDCG lift: -0.044.** The graph is hurting overall ranking quality.

### Root cause

The fan-in boost doesn't distinguish between a file that **defines** a symbol and a file that merely **imports** it. `intel.js` imports nearly everything, so it accumulates the highest fan-in and gets promoted above the actual definition files. The `exact_symbol:+25%` scoring signal fires correctly on definition lines (visible via `--verbose`), but it's overwhelmed by the fan-in boost on hub files.

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

The scoring system needs to differentiate definition sites from call sites. Options:

1. **Cap fan-in boost when `exact_symbol` fires elsewhere.** If another file in the result set has an exact symbol match, reduce the fan-in boost for competing files.
2. **Increase `exact_symbol` weight.** Currently +25% of base, which doesn't overcome fan-in on hub files. Raising to +40-50% might be enough.
3. **Add a definition-line priority signal.** When a hit is a `function`/`class` definition line AND matches the query exactly, give it a stronger boost than generic fan-in.

The eval harness can measure the effect of any of these changes immediately.
