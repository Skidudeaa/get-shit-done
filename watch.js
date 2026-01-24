const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");

const intel = require("./lib/intel");

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function watchRoots(roots, { loadRepoConfig, summaryEverySecOverride = null }) {
  const watchers = [];

  for (const root of roots) {
    const cfg = loadRepoConfig(root);
    const globs = cfg.globs;
    const ignored = cfg.ignore;

    const throttleMs = Math.floor(
      (summaryEverySecOverride ?? cfg.summaryEverySec ?? 0) * 1000
    );

    await intel.init(root);

    const pending = new Set();
    const flush = debounce(async () => {
      const files = [...pending];
      pending.clear();
      if (!files.length) return;

      for (const rel of files) {
        try {
          await intel.updateFile(root, rel, { summaryThrottleMs: throttleMs });
        } catch (e) {
          process.stderr.write(`[intel] ${root}: update failed ${rel}: ${e.message}\n`);
        }
      }
    }, 250);

    const w = chokidar.watch(globs, {
      cwd: root,
      ignoreInitial: true,
      ignored,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const onChange = (rel) => {
      pending.add(rel);
      flush();
    };

    w.on("add", onChange)
      .on("change", onChange)
      .on("unlink", (rel) => {
        // deletion drift is handled by nightly rescan; keep unlink cheap
        process.stderr.write(`[intel] ${root}: unlink ignored ${rel}\n`);
      })
      .on("error", (err) => process.stderr.write(`[intel] ${root}: watcher error: ${err}\n`))
      .on("ready", () =>
        process.stderr.write(`[intel] watching ${root} (${globs.join(", ")})\n`)
      );

    watchers.push(w);
  }

  const shutdown = async (sig) => {
    process.stderr.write(`[intel] shutting down (${sig})\n`);
    for (const w of watchers) {
      try {
        await w.close();
      } catch {}
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {});
}

module.exports = { watchRoots };

// Standalone runner (optional)
if (require.main === module) {
  const flag = (argv, name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : null;
  };

  const readRootsFile = (p) => {
    const txt = fs.readFileSync(p, "utf8");
    return txt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => path.resolve(l));
  };

  const rootsFromArgs = (argv) => {
    const one = flag(argv, "--root");
    const many = flag(argv, "--roots");
    const file = flag(argv, "--roots-file");
    if (file) return readRootsFile(file);
    if (many) return many.split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
    if (one) return [path.resolve(one)];
    return [process.cwd()];
  };

  const loadRepoConfig = (root) => {
    const p = path.join(root, ".codebase-intel.json");
    const defaults = {
      globs: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}", "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.planning/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
      ],
      summaryEverySec: 5,
    };
    if (!fs.existsSync(p)) return defaults;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        globs: cfg.globs?.length ? cfg.globs : defaults.globs,
        ignore: cfg.ignore?.length ? cfg.ignore : defaults.ignore,
        summaryEverySec: Number.isFinite(cfg.summaryEverySec)
          ? cfg.summaryEverySec
          : defaults.summaryEverySec,
      };
    } catch {
      return defaults;
    }
  };

  const secStr = flag(process.argv, "--summary-every");
  const sec = secStr ? Number.parseFloat(secStr) : null;
  if (secStr && (!Number.isFinite(sec) || sec < 0)) {
    process.stderr.write("Invalid --summary-every value\n");
    process.exit(1);
  }

  const roots = rootsFromArgs(process.argv);
  watchRoots(roots, { loadRepoConfig, summaryEverySecOverride: sec }).catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}

