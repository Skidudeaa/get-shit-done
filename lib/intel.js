const fs = require("fs");
const path = require("path");

const fg = require("fast-glob");

const { normalizeRelPath, isIndexable, fileTypeHeuristic } = require("./utils");
const { extractImports, extractExports } = require("./extractor");
const { resolveImport } = require("./resolver");
const graph = require("./graph");
const summary = require("./summary");

const INDEX_VERSION = 1;

const stateByRoot = new Map();

function S(root) {
  const rootAbs = path.resolve(root);
  if (!stateByRoot.has(rootAbs)) {
    stateByRoot.set(rootAbs, {
      rootAbs,
      initialized: false,

      queue: Promise.resolve(),

      indexLoaded: false,
      index: null,
      indexDirty: false,
      indexTimer: null,
      indexScheduledMs: 0,

      graphDirty: false,
      graphTimer: null,
      graphScheduledMs: 0,

      summaryDirty: false,
      summaryTimer: null,
      summaryScheduledMs: 0,
      lastSummaryTimeMs: 0,
    });
  }
  return stateByRoot.get(rootAbs);
}

function withQueue(rootAbs, fn) {
  const st = S(rootAbs);
  const next = st.queue.then(() => fn());
  st.queue = next.catch(() => {});
  return next;
}

function stateDir(rootAbs) {
  return path.join(rootAbs, ".planning", "intel");
}

function indexPath(rootAbs) {
  return path.join(stateDir(rootAbs), "index.json");
}

function summaryPath(rootAbs) {
  return path.join(stateDir(rootAbs), "summary.md");
}

function claudeSettingsPath(rootAbs) {
  return path.join(rootAbs, ".claude", "settings.json");
}

function parseEnvThrottleMs() {
  const v = process.env.INTEL_SUMMARY_THROTTLE_MS;
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function loadIndexUnlocked(st) {
  if (st.indexLoaded && st.index) return st.index;
  st.indexLoaded = true;

  const p = indexPath(st.rootAbs);
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
        st.index = parsed;
        return st.index;
      }
    } catch {
      // fall through
    }
  }

  st.index = {
    version: INDEX_VERSION,
    generatedAt: null,
    files: {},
  };
  st.indexDirty = true;
  await flushIndexUnlocked(st);
  return st.index;
}

async function flushIndexUnlocked(st) {
  if (!st.indexDirty || !st.index) return;
  const p = indexPath(st.rootAbs);
  const tmp = `${p}.tmp`;

  st.index.version = INDEX_VERSION;
  st.index.generatedAt = new Date().toISOString();

  await fs.promises.writeFile(tmp, JSON.stringify(st.index, null, 2) + "\n", "utf8");
  await fs.promises.rename(tmp, p);
  st.indexDirty = false;
}

function scheduleIndexFlush(rootAbs, debounceMs = 750) {
  const st = S(rootAbs);
  if (!st.index) return;
  st.indexDirty = true;

  const now = Date.now();
  const target = now + debounceMs;

  if (st.indexTimer) {
    if (target <= st.indexScheduledMs) return;
    clearTimeout(st.indexTimer);
    st.indexTimer = null;
    st.indexScheduledMs = 0;
  }

  st.indexScheduledMs = target;
  st.indexTimer = setTimeout(() => {
    st.indexTimer = null;
    st.indexScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await flushIndexUnlocked(st);
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.indexTimer.unref?.();
}

async function persistGraphUnlocked(st) {
  if (!st.graphDirty) return;
  await graph.persistDb(st.rootAbs);
  st.graphDirty = false;
}

function scheduleGraphPersist(rootAbs, debounceMs = 750) {
  const st = S(rootAbs);
  st.graphDirty = true;

  const now = Date.now();
  const target = now + debounceMs;

  if (st.graphTimer) {
    if (target <= st.graphScheduledMs) return;
    clearTimeout(st.graphTimer);
    st.graphTimer = null;
    st.graphScheduledMs = 0;
  }

  st.graphScheduledMs = target;
  st.graphTimer = setTimeout(() => {
    st.graphTimer = null;
    st.graphScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await persistGraphUnlocked(st);
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.graphTimer.unref?.();
}

async function writeSummaryUnlocked(st, { force = false } = {}) {
  const rootAbs = st.rootAbs;
  const p = summaryPath(rootAbs);

  if (!force && !st.summaryDirty && fs.existsSync(p)) return readSummary(rootAbs) || "";

  const idx = await loadIndexUnlocked(st);
  const db = await graph.loadDb(rootAbs);

  const md = summary.writeSummaryMarkdown(rootAbs, { index: idx, db, graph });
  await fs.promises.writeFile(p, md, "utf8");

  st.lastSummaryTimeMs = Date.now();
  st.summaryDirty = false;
  return md;
}

function scheduleSummary(rootAbs, { throttleMs = 0, debounceMs = 750 } = {}) {
  const st = S(rootAbs);
  st.summaryDirty = true;

  const now = Date.now();
  const sPath = summaryPath(rootAbs);
  const hasSummary = fs.existsSync(sPath);

  const earliestByThrottle =
    throttleMs > 0 && hasSummary && st.lastSummaryTimeMs > 0
      ? st.lastSummaryTimeMs + throttleMs
      : now;

  const target = Math.max(now + debounceMs, earliestByThrottle);

  if (st.summaryTimer) {
    if (target <= st.summaryScheduledMs) return;
    clearTimeout(st.summaryTimer);
    st.summaryTimer = null;
    st.summaryScheduledMs = 0;
  }

  st.summaryScheduledMs = target;
  st.summaryTimer = setTimeout(() => {
    st.summaryTimer = null;
    st.summaryScheduledMs = 0;
    withQueue(rootAbs, async () => {
      await writeSummaryUnlocked(st, { force: true });
    }).catch(() => {});
  }, Math.max(0, target - now));

  st.summaryTimer.unref?.();
}

async function ensureClaudeSettingsUnlocked(rootAbs) {
  const dir = path.join(rootAbs, ".claude");
  const p = claudeSettingsPath(rootAbs);
  await fs.promises.mkdir(dir, { recursive: true });

  const desiredCmd = "codebase-intel hook sessionstart";
  const desired = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: desiredCmd }],
        },
      ],
    },
  };

  if (!fs.existsSync(p)) {
    await fs.promises.writeFile(p, JSON.stringify(desired, null, 2) + "\n", "utf8");
    return;
  }

  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    // Don't overwrite unreadable user config.
    return;
  }

  if (!current || typeof current !== "object") return;
  if (!current.hooks || typeof current.hooks !== "object") current.hooks = {};
  if (!Array.isArray(current.hooks.SessionStart)) current.hooks.SessionStart = [];

  const arr = current.hooks.SessionStart;
  let entry = arr.find((x) => x && typeof x === "object" && x.matcher === "*");
  if (!entry) {
    entry = { matcher: "*", hooks: [] };
    arr.push(entry);
  }
  if (!Array.isArray(entry.hooks)) entry.hooks = [];
  const hasCmd = entry.hooks.some(
    (h) => h && typeof h === "object" && h.type === "command" && h.command === desiredCmd
  );
  if (!hasCmd) entry.hooks.push({ type: "command", command: desiredCmd });

  await fs.promises.writeFile(p, JSON.stringify(current, null, 2) + "\n", "utf8");
}

async function initUnlocked(st) {
  if (st.initialized) return;
  const rootAbs = st.rootAbs;

  await fs.promises.mkdir(stateDir(rootAbs), { recursive: true });

  // Seed summary throttle from disk.
  try {
    const p = summaryPath(rootAbs);
    if (fs.existsSync(p)) {
      const s = fs.statSync(p);
      st.lastSummaryTimeMs = Math.floor(s.mtimeMs);
    }
  } catch {}

  // Ensure state files exist.
  await graph.loadDb(rootAbs);
  if (!fs.existsSync(graph.graphDbPath(rootAbs))) {
    await graph.persistDb(rootAbs);
  }

  await loadIndexUnlocked(st);
  if (!fs.existsSync(summaryPath(rootAbs))) {
    await fs.promises.writeFile(summaryPath(rootAbs), "", "utf8");
  }

  await ensureClaudeSettingsUnlocked(rootAbs);

  st.initialized = true;
}

function defaultIgnore(ignore) {
  const base = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.planning/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
  ];
  const extra = Array.isArray(ignore) ? ignore : [];
  return [...new Set([...base, ...extra])];
}

async function indexOneFileUnlocked(st, db, relPath) {
  const rel = normalizeRelPath(relPath);
  if (!isIndexable(rel)) return;

  const abs = path.join(st.rootAbs, rel);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    // deletion
    if (st.index?.files?.[rel]) {
      delete st.index.files[rel];
      st.indexDirty = true;
    }
    graph.deleteFile(db, rel);
    st.graphDirty = true;
    return;
  }

  if (!stat.isFile()) return;

  const type = fileTypeHeuristic(rel);
  const sizeBytes = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);

  let code = null;
  if (sizeBytes <= 512 * 1024) {
    try {
      code = await fs.promises.readFile(abs, "utf8");
    } catch {
      code = null;
    }
  }

  const importsRaw = code ? extractImports(code, type) : [];
  const exportsRaw = code ? extractExports(code, type) : [];

  const importsResolved = importsRaw.map((it) => resolveImport(st.rootAbs, rel, it.specifier));

  const importsForIndex = importsResolved.map((r) => ({
    specifier: r.specifier,
    resolved: r.resolved,
    kind: r.kind,
  }));

  const importsForGraph = importsResolved.map((r) => ({
    specifier: r.specifier,
    toPath: r.resolved,
    kind: r.kind,
    isExternal: r.kind === "external" || r.kind === "asset",
  }));

  const now = Date.now();
  st.index.files[rel] = {
    type,
    sizeBytes,
    mtimeMs,
    updatedAtMs: now,
    imports: importsForIndex,
    exports: exportsRaw,
  };
  st.indexDirty = true;

  graph.upsertFile(db, { relPath: rel, type, sizeBytes, mtimeMs });
  graph.replaceImports(db, rel, importsForGraph);
  graph.replaceExports(db, rel, exportsRaw);
  st.graphDirty = true;
}

function staticPrefixFromGlob(glob) {
  const g = String(glob).replace(/\\/g, "/");
  const wildcardIdx = g.search(/[\*\?\[\{]/);
  const prefix = wildcardIdx === -1 ? g : g.slice(0, wildcardIdx);
  if (!prefix) return "";
  if (prefix.endsWith("/")) return prefix;
  const dir = path.posix.dirname(prefix);
  if (dir === "." || dir === "/") return "";
  return dir.endsWith("/") ? dir : `${dir}/`;
}

async function pruneMissingUnderPrefixUnlocked(st, db, prefix) {
  if (!prefix) return 0;
  const files = st.index?.files || {};
  const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
  let pruned = 0;

  for (const rel of keys) {
    const abs = path.join(st.rootAbs, rel);
    if (fs.existsSync(abs)) continue;
    delete files[rel];
    graph.deleteFile(db, rel);
    pruned += 1;
  }

  if (pruned) {
    st.indexDirty = true;
    st.graphDirty = true;
  }
  return pruned;
}

async function init(root) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
  });
}

async function scan(root, globs, opts = {}) {
  const rootAbs = path.resolve(root);
  const ignore = defaultIgnore(opts.ignore);
  const pruneMissing = Boolean(opts.pruneMissing);

  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);

    await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    const globList = Array.isArray(globs) ? globs : [globs];
    for (const g of globList) {
      const matches = await fg(g, {
        cwd: rootAbs,
        onlyFiles: true,
        unique: true,
        dot: false,
        followSymbolicLinks: false,
        ignore,
      });

      for (const rel of matches) {
        await indexOneFileUnlocked(st, db, rel);
      }

      if (pruneMissing) {
        const prefix = staticPrefixFromGlob(g);
        await pruneMissingUnderPrefixUnlocked(st, db, prefix);
      }
    }

    // Force flush after a scan/rescan.
    st.indexDirty = true;
    st.graphDirty = true;
    await flushIndexUnlocked(st);
    await persistGraphUnlocked(st);
    await writeSummaryUnlocked(st, { force: true });
  });
}

async function updateFile(root, relPath, opts = {}) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  const throttleMs =
    Number.isFinite(opts.summaryThrottleMs) && opts.summaryThrottleMs >= 0
      ? Math.floor(opts.summaryThrottleMs)
      : parseEnvThrottleMs() ?? 0;

  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);

    await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    await indexOneFileUnlocked(st, db, rel);

    if (!st.indexDirty && !st.graphDirty) return;

    scheduleIndexFlush(rootAbs);
    scheduleGraphPersist(rootAbs);
    scheduleSummary(rootAbs, { throttleMs });
  });
}

function readSummary(root) {
  const rootAbs = path.resolve(root);
  const p = summaryPath(rootAbs);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

async function writeSummary(root, opts = {}) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    return await writeSummaryUnlocked(st, { force: Boolean(opts.force) });
  });
}

async function health(root) {
  const rootAbs = path.resolve(root);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const idx = await loadIndexUnlocked(st);
    const db = await graph.loadDb(rootAbs);

    const metrics = summary.health(rootAbs, { index: idx, db, graph });

    const state = {
      root: rootAbs,
      stateDir: stateDir(rootAbs),
      graphDb: {
        path: graph.graphDbPath(rootAbs),
        exists: fs.existsSync(graph.graphDbPath(rootAbs)),
      },
      index: {
        path: indexPath(rootAbs),
        exists: fs.existsSync(indexPath(rootAbs)),
        files: Object.keys(idx.files || {}).length,
      },
      summary: {
        path: summaryPath(rootAbs),
        exists: fs.existsSync(summaryPath(rootAbs)),
      },
      claudeSettings: {
        path: claudeSettingsPath(rootAbs),
        exists: fs.existsSync(claudeSettingsPath(rootAbs)),
      },
      metrics,
      localResolved: metrics.localResolved,
      localTotal: metrics.localTotal,
      resolutionPct: metrics.resolutionPct,
      topMisses: metrics.topMisses,
      indexAgeSec: metrics.indexAgeSec,
      indexGeneratedAt: metrics.indexGeneratedAt,
    };

    return state;
  });
}

async function queryImports(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryImports(db, rel);
  });
}

async function queryDependents(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryDependents(db, rel);
  });
}

async function queryExports(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = normalizeRelPath(relPath);
  return withQueue(rootAbs, async () => {
    const st = S(rootAbs);
    await initUnlocked(st);
    const db = await graph.loadDb(rootAbs);
    return graph.queryExports(db, rel);
  });
}

module.exports = {
  init,
  scan,
  updateFile,
  readSummary,
  writeSummary,
  health,
  queryImports,
  queryDependents,
  queryExports,
};
