#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const intel = require("../lib/intel");
const { retrieve } = require("../lib/retrieve");
const zoekt = require("../lib/zoekt");

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readRootsFile(p) {
  const txt = fs.readFileSync(p, "utf8");
  return txt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => path.resolve(l));
}

function rootsFromArgs(argv) {
  const one = flag(argv, "--root");
  const many = flag(argv, "--roots");
  const file = flag(argv, "--roots-file");

  if (file) return readRootsFile(file);
  if (many) return many.split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
  if (one) return [path.resolve(one)];
  return [process.cwd()];
}

function loadRepoConfig(root) {
  const p = path.join(root, ".codebase-intel.json");
  const defaults = {
    globs: [
      // JavaScript / TypeScript
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "app/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      // Python
      "**/*.py",
    ],
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.planning/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      // Python
      "**/__pycache__/**",
      "**/.venv/**",
      "**/venv/**",
      "**/.tox/**",
      "**/site-packages/**",
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
}

async function readStdinJson() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      try {
        resolve(input ? JSON.parse(input) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function usage(exitCode = 1) {
  console.log(`Usage:
  codebase-intel init [--root <path> | --roots <a,b> | --roots-file <file>]
  codebase-intel scan [--root/--roots/--roots-file]
  codebase-intel rescan [--root/--roots/--roots-file]
  codebase-intel update --file <relPath> [--root <path>]
  codebase-intel watch [--root/--roots/--roots-file] [--summary-every <sec>]
  codebase-intel summary [--root <path>]
  codebase-intel health [--root <path>]
  codebase-intel query <imports|dependents|exports> --file <relPath> [--root <path>]
  codebase-intel hook sessionstart
  codebase-intel hook refresh
  codebase-intel inject
  codebase-intel retrieve <query>
  codebase-intel zoekt <index|serve|search>`);
  process.exit(exitCode);
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // ---- hook sessionstart (Claude Code) ----
  if (cmd === "hook" && argv[1] === "sessionstart") {
    const root = process.cwd();
    const data = await readStdinJson();
    const src = data.source;
    if (src && !["startup", "resume"].includes(src)) process.exit(0);

    await intel.init(root);
    const summary = intel.readSummary(root);
    if (!summary || !summary.trim()) process.exit(0);

    process.stdout.write(
      `<codebase-intelligence>\n${summary.trim()}\n</codebase-intelligence>`
    );
    process.exit(0);
  }

  // ---- hook refresh (mid-session, on UserPromptSubmit) ----
  if (cmd === "hook" && argv[1] === "refresh") {
    const crypto = require("crypto");
    const root = process.cwd();
    const summaryPath = path.join(root, ".planning", "intel", "summary.md");

    const data = await readStdinJson();

    if (!fs.existsSync(summaryPath)) process.exit(0);

    const summary = fs.readFileSync(summaryPath, "utf8").trim();
    if (!summary) process.exit(0);

    // Per-session dedupe: derive session key from hook payload or env
    const sessionKey = (
      data?.session_id ||
      data?.conversation_id ||
      data?.run_id ||
      data?.terminal_id ||
      process.env.CURSOR_SESSION_ID ||
      process.env.TMUX_PANE ||
      process.env.SSH_TTY ||
      String(process.ppid || process.pid)
    )
      .toString()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80);

    const cachePath = path.join(
      root,
      ".planning",
      "intel",
      `.last_injected_hash.${sessionKey}`
    );

    const h = crypto.createHash("sha256").update(summary).digest("hex");
    const last = fs.existsSync(cachePath)
      ? fs.readFileSync(cachePath, "utf8").trim()
      : "";

    // Only inject if changed since last injection for this session
    if (last === h) process.exit(0);

    fs.writeFileSync(cachePath, h);

    // Use same tag as SessionStart for consistency
    process.stdout.write(
      `<codebase-intelligence>\n(refreshed: ${new Date().toISOString()})\n${summary}\n</codebase-intelligence>`
    );
    process.exit(0);
  }

  if (cmd === "inject") {
    const root = process.cwd();
    await intel.init(root);
    const summary = intel.readSummary(root);
    if (!summary || !summary.trim()) process.exit(0);
    process.stdout.write(
      `<codebase-intelligence>\n${summary.trim()}\n</codebase-intelligence>`
    );
    process.exit(0);
  }

  const roots = rootsFromArgs(process.argv);

  switch (cmd) {
    case "init": {
      for (const r of roots) await intel.init(r);
      break;
    }

    case "scan":
    case "rescan": {
      const pruneMissing = cmd === "rescan";
      // Collect positional glob arguments (after cmd, before --flags)
      const cliGlobs = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) break;
        cliGlobs.push(a);
      }

      for (const r of roots) {
        const cfg = loadRepoConfig(r);
        const globs = cliGlobs.length ? cliGlobs : cfg.globs;
        await intel.scan(r, globs, { ignore: cfg.ignore, pruneMissing });
      }
      break;
    }

    case "update": {
      const r = roots[0];
      const rel = flag(process.argv, "--file") || argv[1];
      if (!rel) usage(1);
      await intel.updateFile(r, rel);
      break;
    }

    case "watch": {
      const secStr = flag(process.argv, "--summary-every");
      const sec = secStr ? Number.parseFloat(secStr) : null;
      if (secStr && (!Number.isFinite(sec) || sec < 0)) {
        console.error("Invalid --summary-every value");
        process.exit(1);
      }

      const { watchRoots } = require("../watch");
      await watchRoots(roots, {
        loadRepoConfig,
        summaryEverySecOverride: sec,
      });
      break;
    }

    case "summary": {
      const r = roots[0];
      const s = intel.readSummary(r);
      process.stdout.write(s && s.trim() ? s : "No summary\n");
      break;
    }

    case "health": {
      const r = roots[0];
      const h = await intel.health(r);
      process.stdout.write(JSON.stringify(h, null, 2) + "\n");
      break;
    }

    case "query": {
      const sub = argv[1];
      const r = roots[0];
      const rel = flag(process.argv, "--file") || argv[2];
      if (!sub || !rel) usage(1);

      if (sub === "imports") {
        const out = await intel.queryImports(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (sub === "dependents") {
        const out = await intel.queryDependents(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (sub === "exports") {
        const out = await intel.queryExports(r, rel);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else {
        usage(1);
      }
      break;
    }

    case "retrieve": {
      const r = roots[0];
      const boolFlags = new Set(["--explain-hits", "--zoekt-build"]);
      const parts = [];
      for (let i = 1; i < argv.length; i += 1) {
        const a = argv[i];
        if (a.startsWith("--")) {
          if (boolFlags.has(a)) continue;
          i += 1;
          continue;
        }
        parts.push(a);
      }
      const q = parts.join(" ").trim();
      if (!q) {
        console.error(
          "Usage: codebase-intel retrieve <query> [--backend auto|zoekt|rg] [--context N] [--max-hits N] [--max-files N] [--expand imports,dependents] [--max-related N] [--hits-per-file N] [--explain-hits] [--rerank-min-resolution N] [--zoekt-build] [--zoekt-port N]"
        );
        process.exit(1);
      }

      const backend = flag(process.argv, "--backend");
      const contextLines = parseInt(flag(process.argv, "--context") || "", 10);
      const maxHits = parseInt(flag(process.argv, "--max-hits") || "", 10);
      const maxFiles = parseInt(flag(process.argv, "--max-files") || "", 10);
      const maxRelated = parseInt(flag(process.argv, "--max-related") || "", 10);
      const hitsPerFile = parseInt(flag(process.argv, "--hits-per-file") || "", 10);
      const rerankMinResolution = parseInt(flag(process.argv, "--rerank-min-resolution") || "", 10);
      const expandRaw = flag(process.argv, "--expand");
      const zoektPort = parseInt(flag(process.argv, "--zoekt-port") || "", 10);

      const out = await retrieve(r, q, {
        backend: backend || "auto",
        contextLines: Number.isFinite(contextLines) ? contextLines : 1,
        maxHits: Number.isFinite(maxHits) ? maxHits : 50,
        maxSeedFiles: Number.isFinite(maxFiles) ? maxFiles : 10,
        expand: expandRaw
          ? expandRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : ["imports", "dependents"],
        maxRelated: Number.isFinite(maxRelated) ? maxRelated : 30,
        hitsPerFileCap: Number.isFinite(hitsPerFile) ? hitsPerFile : 5,
        explainHits: hasFlag(process.argv, "--explain-hits"),
        rerankMinResolutionPct: Number.isFinite(rerankMinResolution)
          ? rerankMinResolution
          : 90,
        zoektBuild: hasFlag(process.argv, "--zoekt-build"),
        zoektPort: Number.isFinite(zoektPort) ? zoektPort : 6070,
      });

      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      break;
    }

    case "zoekt": {
      const sub = argv[1];
      const r = roots[0];
      if (!sub) {
        console.error("Usage: codebase-intel zoekt <index|serve|search> ...");
        process.exit(1);
      }

      if (sub === "index") {
        const force = hasFlag(process.argv, "--force");
        const res = zoekt.buildIndex(r, { force });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      if (sub === "serve") {
        const port = parseInt(flag(process.argv, "--port") || "", 10);
        const autoIndex = hasFlag(process.argv, "--build");
        const res = await zoekt.ensureWebserver(r, {
          port: Number.isFinite(port) ? port : 6070,
          autoIndex,
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      if (sub === "search") {
        const parts = [];
        for (let i = 2; i < argv.length; i += 1) {
          const a = argv[i];
          if (a.startsWith("--")) {
            i += 1;
            continue;
          }
          parts.push(a);
        }
        const q = parts.join(" ").trim();
        if (!q) {
          console.error("Usage: codebase-intel zoekt search <query>");
          process.exit(1);
        }
        const port = parseInt(flag(process.argv, "--port") || "", 10);
        const contextLines = parseInt(flag(process.argv, "--context") || "", 10);
        const maxHits = parseInt(flag(process.argv, "--max-hits") || "", 10);

        const res = await zoekt.search(r, q, {
          port: Number.isFinite(port) ? port : 6070,
          contextLines: Number.isFinite(contextLines) ? contextLines : 1,
          maxHits: Number.isFinite(maxHits) ? maxHits : 50,
        });
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        break;
      }

      console.error("Usage: codebase-intel zoekt <index|serve|search> ...");
      process.exit(1);
    }

    default:
      usage(1);
  }
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
