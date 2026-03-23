const intel = require("./intel");
const rg = require("./rg");
const zoekt = require("./zoekt");
const graph = require("./graph");
const scoring = require("./scoring");

// WHY: rg returns paths with "./" prefix ("./lib/retrieve.js") but the graph DB
// stores bare relative paths ("lib/retrieve.js"). Normalizing before graph queries
// prevents silent fan-in=0 from path mismatch — without this, graph boosts never fire.
function normalizeHitPath(p) {
  return String(p).replace(/^\.\//, "");
}

function isEntryPoint(relPath) {
  return /(src\/)?(main|index|app|root|router|routes)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(
    relPath || ""
  );
}

function isTestPath(p) {
  if (!p) return false;
  return /(^|\/)(__tests__|__test__|tests?|specs?)\//i.test(p) || /\.(test|spec)\./i.test(p);
}

function isVendorPath(p) {
  if (!p) return false;
  return /(^|\/)(node_modules|dist|build|coverage|\.next|out|vendor)\//i.test(p);
}

function looksLikeExportLine(line) {
  return typeof line === "string" && /^\s*export\b/.test(line);
}

function looksLikeDefinitionLine(line) {
  if (typeof line !== "string") return false;
  return (
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/.test(line) ||
    /^\s*(export\s+)?(default\s+)?class\b/.test(line) ||
    /^\s*export\s+(const|let|var|type|interface)\b/.test(line)
  );
}

function safeNum(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function groupHitsByFile(hits) {
  const m = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!m.has(h.path)) m.set(h.path, []);
    m.get(h.path).push(h);
  }
  return m;
}

function addScopeContextToHits(root, hits, { contextMode, maxScopeLines }) {
  const scopeFinder = require("./scope-finder");
  const path = require("path");

  const byFile = groupHitsByFile(hits);
  for (const [relPath, fileHits] of byFile.entries()) {
    const absPath = path.join(root, relPath);
    const lineNumbers = fileHits.map((h) => h.lineNumber).filter((n) => Number.isFinite(n));
    if (!lineNumbers.length) continue;

    const scopeMap = scopeFinder.findEnclosingScopeBatch(absPath, lineNumbers, {
      mode: contextMode,
    });

    for (const h of fileHits) {
      const scopeInfo = scopeMap.get(h.lineNumber);
      if (!scopeInfo) {
        // Keep existing line context as a fallback.
        h.scope = null;
        continue;
      }

      const { lines, truncated, matchLineWithinScope } = scopeFinder.readScopeLines(
        absPath,
        scopeInfo,
        h.lineNumber,
        maxScopeLines
      );

      h.scope = {
        name: scopeInfo.name,
        kind: scopeInfo.kind,
        startLine: scopeInfo.startLine,
        endLine: scopeInfo.endLine,
        totalLines: scopeInfo.totalLines,
        maxLines: maxScopeLines,
        lines,
        truncated,
        matchLineWithinScope,
      };

      // Clear line-based context when using scope context
      h.before = [];
      h.after = [];
    }
  }
}

function pickBackend(backendOpt, root, { zoektBuild = false } = {}) {
  if (backendOpt === "zoekt") return "zoekt";
  if (backendOpt === "rg") return "rg";

  if (zoekt.isInstalled()) {
    if (zoekt.hasIndex(root) || zoektBuild) return "zoekt";
  }
  return "rg";
}

function rerankFiles(files, { useGraphBoost = true } = {}) {
  return files.sort((a, b) => {
    const ea = a.isEntryPoint ? 1 : 0;
    const eb = b.isEntryPoint ? 1 : 0;
    if (ea !== eb) return eb - ea;

    if (useGraphBoost) {
      const fa = safeNum(a.fanIn, 0);
      const fb = safeNum(b.fanIn, 0);
      if (fa !== fb) return fb - fa;
    }

    const ha = safeNum(a.hitCount, 0);
    const hb = safeNum(b.hitCount, 0);
    if (ha !== hb) return hb - ha;

    const sa = safeNum(a.bestAdjustedHitScore, safeNum(a.bestHitScore, -Infinity));
    const sb = safeNum(b.bestAdjustedHitScore, safeNum(b.bestHitScore, -Infinity));
    return sb - sa;
  });
}

function computeAdjustedHitScore(hit, fileMeta, opts) {
  const explain = !!opts.explainHits;
  const useGraphBoost = opts.useGraphBoost !== false;
  const queryTerms = opts.queryTerms || [];

  const base = Number.isFinite(hit.score) ? hit.score : 1;
  let adjusted = base;
  const signals = [];

  if (fileMeta) {
    if (fileMeta.isEntryPoint) {
      adjusted += base * 0.1;
      if (explain) signals.push("entrypoint:+10%");
    }

    if (useGraphBoost) {
      if (fileMeta.isHotspot) {
        adjusted += base * 0.15;
        if (explain) signals.push("hotspot:+15%");
      }

      const fanIn = safeNum(fileMeta.fanIn, 0);
      if (fanIn > 0) {
        const frac = Math.min(0.15, Math.log1p(fanIn) * 0.02);
        adjusted += base * frac;
        if (explain) signals.push(`fanin:${fanIn}:+${Math.round(frac * 100)}%`);
      }
    }

    if (isTestPath(fileMeta.path)) {
      adjusted -= base * 0.25;
      if (explain) signals.push("test:-25%");
    }

    if (isVendorPath(fileMeta.path)) {
      adjusted -= base * 0.5;
      if (explain) signals.push("vendor:-50%");
    }
  }

  if (looksLikeExportLine(hit.line)) {
    adjusted += base * 0.05;
    if (explain) signals.push("exportline:+5%");
  }
  if (looksLikeDefinitionLine(hit.line)) {
    adjusted += base * 0.03;
    if (explain) signals.push("defline:+3%");
  }

  // WHY: Strong definition-site priority (+25%) when a hit is a function/class
  // definition AND the query matches the symbol name.  This is separate from the
  // generic defline:+3% above and from the exact_symbol signal in scoring.js.
  // Together they ensure the file where a symbol is *defined* outranks hub files
  // that merely *import* it (the #1 eval finding: intel.js beating resolver.js).
  if (queryTerms.length > 0) {
    const defSym = scoring.extractSymbolDef(hit.line);
    if (defSym) {
      const defLower = defSym.toLowerCase();
      const matchesQuery = queryTerms.some((t) => t.toLowerCase() === defLower);
      if (matchesQuery) {
        adjusted += base * 0.25;
        if (explain) signals.push("def_site_priority:+25%");
        // Tag the hit so the fan-in suppression pass (below) can identify
        // files that contain a true definition match.
        hit._hasDefSiteMatch = true;
      }
    }
  }

  // Apply enhanced scoring signals (symbol-aware, noise penalty, etc.)
  if (queryTerms.length > 0) {
    const enhanced = scoring.computeEnhancedSignals(hit, queryTerms, { explainHits: explain });
    adjusted += enhanced.adjustment || 0;
    if (explain && enhanced.signals) {
      signals.push(...enhanced.signals);
    }
  }

  if (!Number.isFinite(hit.score)) {
    if (fileMeta?.isEntryPoint) adjusted += 0.2;
    if (useGraphBoost && fileMeta?.isHotspot) adjusted += 0.25;
    if (useGraphBoost)
      adjusted += Math.min(0.25, Math.log1p(safeNum(fileMeta?.fanIn, 0)) * 0.05);
  }

  adjusted = Math.max(0, adjusted);
  return explain ? { adjustedScore: adjusted, signals } : { adjustedScore: adjusted };
}

function rerankAndCapHits(hits, fileByPath, opts) {
  const maxHits = safeNum(opts.maxHits, hits.length);
  const cap = Number.isFinite(opts.hitsPerFileCap) ? opts.hitsPerFileCap : 5;

  const scored = hits.map((h) => {
    const fm = fileByPath.get(h.path);
    const extra = computeAdjustedHitScore(h, fm, opts);
    return {
      ...h,
      baseScore: Number.isFinite(h.score) ? h.score : null,
      ...extra,
    };
  });

  // WHY — Fan-in suppression when a definition match exists:
  // If ANY hit in the result set landed on the actual definition site of the
  // queried symbol (tagged _hasDefSiteMatch by computeAdjustedHitScore), then
  // hub files that merely *import* the symbol should not outrank the definition
  // file just because they have high fan-in.  We collect the set of files that
  // contain a definition match.  For hits in files WITHOUT such a match, we
  // re-compute the adjusted score with the fan-in/hotspot component halved.
  // This is the most impactful of the three fixes: it directly prevents
  // intel.js (fan-in=5) from outranking resolver.js / summary.js / scoring.js.
  if (opts.useGraphBoost !== false) {
    const filesWithDefMatch = new Set();
    for (const h of scored) {
      if (h._hasDefSiteMatch) filesWithDefMatch.add(h.path);
    }

    if (filesWithDefMatch.size > 0) {
      for (const h of scored) {
        if (filesWithDefMatch.has(h.path)) continue; // definition file — keep score
        const fm = fileByPath.get(h.path);
        if (!fm) continue;
        const fanIn = safeNum(fm.fanIn, 0);
        const isHotspot = !!fm.isHotspot;
        if (fanIn <= 0 && !isHotspot) continue; // no graph boost to suppress

        // Calculate the graph-boost portion that was added, then halve it.
        const base = Number.isFinite(h.baseScore) ? h.baseScore : 1;
        let graphPortion = 0;
        if (isHotspot) graphPortion += base * 0.15;
        if (fanIn > 0) graphPortion += base * Math.min(0.15, Math.log1p(fanIn) * 0.02);
        // Also account for the non-finite-score graph fallback path
        if (!Number.isFinite(h.baseScore)) {
          if (isHotspot) graphPortion += 0.25;
          graphPortion += Math.min(0.25, Math.log1p(fanIn) * 0.05);
        }

        // Halve the graph contribution — enough to let definition-site
        // signals win, but not so aggressive that hub files disappear entirely.
        const reduction = graphPortion * 0.5;
        h.adjustedScore = Math.max(0, safeNum(h.adjustedScore) - reduction);
        if (opts.explainHits && Array.isArray(h.signals)) {
          h.signals.push(`fanin_suppressed:-${Math.round((reduction / Math.max(base, 0.001)) * 100)}%`);
        }
      }
    }
  }

  scored.sort((a, b) => safeNum(b.adjustedScore) - safeNum(a.adjustedScore));

  if (cap <= 0) return scored.slice(0, maxHits);

  const perFile = new Map();
  const out = [];

  for (const h of scored) {
    const k = h.path || "";
    const c = perFile.get(k) || 0;
    if (c >= cap) continue;
    perFile.set(k, c + 1);
    out.push(h);
    if (out.length >= maxHits) break;
  }

  return out;
}

async function retrieve(root, q, opts = {}) {
  const backendOpt = opts.backend ?? "auto";
  const contextLines = opts.contextLines ?? 1;
  const contextMode = opts.contextMode ?? "lines"; // "lines" | "function" | "class"
  const maxScopeLines = opts.maxScopeLines ?? 200;
  const maxHits = opts.maxHits ?? 50;
  const maxSeedFiles = opts.maxSeedFiles ?? 10;
  const expand =
    Array.isArray(opts.expand) && opts.expand.length
      ? opts.expand
      : ["imports", "dependents"];
  const maxRelated = opts.maxRelated ?? 30;

  const hitsPerFileCap = Number.isFinite(opts.hitsPerFileCap) ? opts.hitsPerFileCap : 5;
  const explainHits = !!opts.explainHits;

  const zoektBuild = !!opts.zoektBuild;
  const zoektPort = opts.zoektPort ?? 6070;

  const warnings = [];

  // Extract query terms for scoring (split on whitespace, clean up)
  const queryTerms = q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""));

  const h = await intel.health(root);
  const rerankMinResolutionPct = opts.rerankMinResolutionPct ?? 90;
  const resolutionPct = h?.resolutionPct ?? h?.metrics?.resolutionPct ?? 100;

  const backend = pickBackend(backendOpt, root, { zoektBuild });
  let searchRes;

  if (backend === "zoekt") {
    try {
      searchRes = await zoekt.search(root, q, {
        maxHits,
        contextLines,
        contextMode,
        maxScopeLines,
        autoIndex: zoektBuild,
        port: zoektPort,
      });
    } catch (e) {
      warnings.push(`zoekt failed; falling back to rg: ${e.message}`);
      searchRes = await rg.search(root, q, {
        maxHits,
        contextLines,
        contextMode,
        maxScopeLines,
        mode: opts.rgMode || "literal",
      });
    }
  } else {
    searchRes = await rg.search(root, q, {
      maxHits,
      contextLines,
      contextMode,
      maxScopeLines,
      mode: opts.rgMode || "literal",
    });
  }

  const hits = searchRes.hits || [];
  // Normalize hit paths so graph lookups match the stored relative paths
  for (const h of hits) {
    if (h.path) h.path = normalizeHitPath(h.path);
  }
  if ((contextMode === "function" || contextMode === "class") && hits.length) {
    // rg applies scope context inside lib/rg.js. Zoekt needs post-processing.
    if (searchRes.provider !== "rg") {
      try {
        addScopeContextToHits(root, hits, { contextMode, maxScopeLines });
      } catch (e) {
        warnings.push(`scope context failed: ${e?.message || String(e)}`);
      }
    }
  }
  const byFile = groupHitsByFile(hits);
  const filePaths = [...byFile.keys()];

  const fileResults = [];
  for (const p of filePaths) {
    const hs = byFile.get(p) || [];
    const bestHitScore = hs.reduce(
      (m, x) => (x.score != null && x.score > m ? x.score : m),
      -Infinity
    );

    fileResults.push({
      path: p,
      id: p,
      type: null,
      hitCount: hs.length,
      bestHitScore: Number.isFinite(bestHitScore) ? bestHitScore : null,
      bestAdjustedHitScore: null,
      fanIn: null,
      fanOut: null,
      isEntryPoint: isEntryPoint(p),
      isHotspot: false,
    });
  }

  let graphAvailable = false;
  let db = null;
  try {
    db = await graph.loadDb(root);
    graphAvailable = graph.countFiles(db) > 0;
  } catch {
    graphAvailable = false;
  }

  if (graphAvailable && db) {
    const meta = graph.fileMetaByPaths(db, filePaths);
    const fanIn = graph.fanInByPaths(db, filePaths);
    const fanOut = graph.fanOutByPaths(db, filePaths);

    for (const f of fileResults) {
      const m = meta.get(f.path);
      f.type = m?.type || "unknown";
      f.fanIn = fanIn.get(f.path) || 0;
      f.fanOut = fanOut.get(f.path) || 0;
    }

    const sortedFanIn = [...fileResults].sort((a, b) => (b.fanIn || 0) - (a.fanIn || 0));
    const cutoff = sortedFanIn[Math.min(sortedFanIn.length - 1, 4)]?.fanIn || 0;
    for (const f of fileResults) {
      f.isHotspot = (f.fanIn || 0) >= cutoff && (f.fanIn || 0) > 0;
    }
  } else {
    warnings.push("graph not available; related expansion disabled");
  }

  const fileByPath = new Map(fileResults.map((f) => [f.path, f]));
  const useGraphBoost = graphAvailable && resolutionPct >= rerankMinResolutionPct;

  const rerankedHits = rerankAndCapHits(hits, fileByPath, {
    maxHits,
    hitsPerFileCap,
    explainHits,
    useGraphBoost,
    queryTerms,
  });

  const bestAdj = new Map();
  for (const h2 of rerankedHits) {
    const prev = bestAdj.get(h2.path) ?? -Infinity;
    if (h2.adjustedScore != null && h2.adjustedScore > prev) bestAdj.set(h2.path, h2.adjustedScore);
  }
  for (const f of fileResults) {
    f.bestAdjustedHitScore = bestAdj.has(f.path) ? bestAdj.get(f.path) : null;
  }

  rerankFiles(fileResults, { useGraphBoost });

  const seed = fileResults.slice(0, maxSeedFiles);
  const related = [];
  if (graphAvailable && db) {
    for (const s of seed) {
      const n = graph.neighbors(db, s.path, { maxImports: 15, maxDependents: 15 });
      if (expand.includes("imports")) {
        for (const p of n.imports) related.push({ from: s.path, relation: "imports", path: p });
      }
      if (expand.includes("dependents")) {
        for (const p of n.dependents)
          related.push({ from: s.path, relation: "depended_on_by", path: p });
      }
    }

    const relatedPaths = uniq(related.map((r) => r.path));
    const relMeta = graph.fileMetaByPaths(db, relatedPaths);
    const relFanIn = graph.fanInByPaths(db, relatedPaths);

    for (const r of related) {
      const m = relMeta.get(r.path);
      r.type = m?.type || "unknown";
      r.fanIn = relFanIn.get(r.path) || 0;
    }
  }

  const seenRel = new Set();
  const relatedClean = [];
  for (const r of related) {
    if (!r.path) continue;
    const k = `${r.relation}:${r.path}`;
    if (seenRel.has(k)) continue;
    seenRel.add(k);
    relatedClean.push(r);
    if (relatedClean.length >= maxRelated) break;
  }

  let git = null;
  try {
    const { execSync } = require("child_process");
    git = {
      branch: execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      head: execSync("git rev-parse HEAD", {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    };
  } catch {}

  return {
    schema: "codebase-intel.retrieve.v1",
    timestamp: new Date().toISOString(),
    repo: { root, git },
    query: {
      q,
      terms: queryTerms,
      opts: {
        backend: backendOpt,
        contextLines,
        contextMode,
        maxScopeLines,
        maxHits,
        maxSeedFiles,
        expand,
        maxRelated,
        hitsPerFileCap,
        explainHits,
        rerankMinResolutionPct,
      },
    },
    providers: {
      search: { name: searchRes.provider, details: searchRes.details || null },
      graph: { available: graphAvailable },
    },
    health: h,
    results: {
      files: fileResults,
      hits: rerankedHits,
      related: relatedClean,
    },
    warnings,
  };
}

module.exports = { retrieve };
