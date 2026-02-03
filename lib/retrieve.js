const intel = require("./intel");
const rg = require("./rg");
const zoekt = require("./zoekt");
const graph = require("./graph");
const scoring = require("./scoring");

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
  const maxHits = opts.maxHits ?? 50;
  const maxSeedFiles = opts.maxSeedFiles ?? 10;
  const expand =
    Array.isArray(opts.expand) && opts.expand.length
      ? opts.expand
      : ["imports", "dependents"];
  const maxRelated = opts.maxRelated ?? 30;

  const hitsPerFileCap = Number.isFinite(opts.hitsPerFileCap) ? opts.hitsPerFileCap : 5;
  const explainHits = !!opts.explainHits;
  const enableQueryExpansion = opts.queryExpansion !== false;

  const zoektBuild = !!opts.zoektBuild;
  const zoektPort = opts.zoektPort ?? 6070;

  const warnings = [];

  // Query expansion for better recall
  const queryInfo = enableQueryExpansion ? scoring.expandQuery(q) : { original: q, expanded: q, terms: [q] };
  const searchQuery = queryInfo.expanded;
  const queryTerms = queryInfo.terms;

  if (enableQueryExpansion && queryInfo.expanded !== q) {
    warnings.push(`query expanded: ${q} -> ${queryInfo.expanded}`);
  }

  const h = await intel.health(root);
  const rerankMinResolutionPct = opts.rerankMinResolutionPct ?? 90;
  const resolutionPct = h?.resolutionPct ?? h?.metrics?.resolutionPct ?? 100;

  const backend = pickBackend(backendOpt, root, { zoektBuild });
  let searchRes;

  if (backend === "zoekt") {
    try {
      searchRes = await zoekt.search(root, searchQuery, {
        maxHits,
        contextLines,
        autoIndex: zoektBuild,
        port: zoektPort,
      });
    } catch (e) {
      warnings.push(`zoekt failed; falling back to rg: ${e.message}`);
      searchRes = await rg.search(root, q, {
        maxHits,
        contextLines,
        mode: opts.rgMode || "literal",
      });
    }
  } else {
    searchRes = await rg.search(root, q, {
      maxHits,
      contextLines,
      mode: opts.rgMode || "literal",
    });
  }

  const hits = searchRes.hits || [];
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
      expanded: enableQueryExpansion && queryInfo.expanded !== q ? queryInfo.expanded : null,
      terms: queryTerms,
      opts: {
        backend: backendOpt,
        contextLines,
        maxHits,
        maxSeedFiles,
        expand,
        maxRelated,
        hitsPerFileCap,
        explainHits,
        rerankMinResolutionPct,
        queryExpansion: enableQueryExpansion,
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
