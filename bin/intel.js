#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const intel = require("../lib/intel");

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
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
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "app/**/*.{ts,tsx,js,jsx,mjs,cjs}",
    ],
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
  codebase-intel inject`);
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
      for (const r of roots) {
        const cfg = loadRepoConfig(r);
        await intel.scan(r, cfg.globs, { ignore: cfg.ignore, pruneMissing });
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

    default:
      usage(1);
  }
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});

