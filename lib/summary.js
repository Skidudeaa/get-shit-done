const fs = require("fs");
const path = require("path");

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function detectSignals(rootAbs) {
  const signals = [];
  const pkg = readJsonIfExists(path.join(rootAbs, "package.json"));

  if (pkg) {
    signals.push("Node: package.json");
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) signals.push("Framework: Next.js");
    else if (deps["react-scripts"]) signals.push("Framework: Create React App");
    else if (deps.vite) signals.push("Tooling: Vite");
    else if (deps["@angular/core"]) signals.push("Framework: Angular");
    else if (deps.vue) signals.push("Framework: Vue");
    else if (deps.svelte) signals.push("Framework: Svelte");
  }

  if (fs.existsSync(path.join(rootAbs, "pyproject.toml"))) signals.push("Python: pyproject.toml");
  else if (fs.existsSync(path.join(rootAbs, "requirements.txt")))
    signals.push("Python: requirements.txt");

  if (fs.existsSync(path.join(rootAbs, "go.mod"))) signals.push("Go: go.mod");
  if (fs.existsSync(path.join(rootAbs, "Cargo.toml"))) signals.push("Rust: Cargo.toml");
  if (fs.existsSync(path.join(rootAbs, "Package.swift"))) signals.push("Swift: Package.swift");
  if (fs.existsSync(path.join(rootAbs, "Gemfile"))) signals.push("Ruby: Gemfile");

  return { pkg, signals };
}

function topDirsFromFiles(files, limit = 10) {
  const counts = new Map();
  for (const rel of files) {
    const top = rel.includes("/") ? rel.split("/")[0] : "(root)";
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([dir, c]) => ({ dir, c }));
}

function typeCounts(indexFiles) {
  const counts = new Map();
  for (const v of Object.values(indexFiles || {})) {
    const t = v?.type || "other";
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function mdEscapeInline(s) {
  return String(s).replace(/`/g, "\\`");
}

function writeSummaryMarkdown(rootAbs, { index, db, graph }) {
  const files = Object.keys(index?.files || {});
  const total = files.length;
  if (!total) {
    return [
      "## Codebase intelligence",
      "",
      `- **Root**: \`${mdEscapeInline(rootAbs)}\``,
      `- **Generated**: ${new Date().toISOString()}`,
      "",
      "No indexed files yet.",
      "",
      "Run:",
      "",
      "```bash",
      "codebase-intel rescan",
      "```",
      "",
    ].join("\n");
  }

  const dirs = topDirsFromFiles(files, 8);
  const types = typeCounts(index.files).slice(0, 8);

  const { signals } = detectSignals(rootAbs);

  const external = graph.topExternalImports(db, 12);
  const hot = graph.hotFilesByImportCount(db, 8);
  const depended = graph.mostDependedOn(db, 8);

  const lines = [];
  lines.push("## Codebase intelligence");
  lines.push("");
  lines.push(`- **Root**: \`${mdEscapeInline(rootAbs)}\``);
  lines.push(`- **Indexed files**: ${total}`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push("");

  if (signals.length) {
    lines.push("### Signals");
    for (const s of signals) lines.push(`- ${s}`);
    lines.push("");
  }

  if (types.length) {
    lines.push("### Languages / types (top)");
    for (const [t, c] of types) lines.push(`- **${t}**: ${c}`);
    lines.push("");
  }

  if (dirs.length) {
    lines.push("### Top areas");
    for (const d of dirs) lines.push(`- **${d.dir}/**: ${d.c} files`);
    lines.push("");
  }

  if (external.length) {
    lines.push("### External imports (top)");
    for (const row of external) lines.push(`- \`${mdEscapeInline(row.specifier)}\`: ${row.c}`);
    lines.push("");
  }

  if (hot.length) {
    lines.push("### Hot files (most imports)");
    for (const row of hot) lines.push(`- \`${mdEscapeInline(row.path)}\`: ${row.c}`);
    lines.push("");
  }

  if (depended.length) {
    lines.push("### Most depended-on (internal)");
    for (const row of depended) lines.push(`- \`${mdEscapeInline(row.path)}\`: ${row.c}`);
    lines.push("");
  }

  lines.push("### State");
  lines.push("- `.planning/intel/graph.db` (SQLite graph)");
  lines.push("- `.planning/intel/index.json` (per-file imports/exports)");
  lines.push("- `.planning/intel/summary.md` (this file)");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function health(rootAbs, { index, db, graph }) {
  const files = Object.keys(index?.files || {});
  const total = files.length;
  const topTypes = typeCounts(index?.files || {}).slice(0, 10).map(([t, c]) => ({ t, c }));

  const out = {
    root: rootAbs,
    indexedFiles: total,
    typeCounts: topTypes,
    graph: {
      files: graph.countFiles(db),
    },
  };

  return out;
}

module.exports = {
  writeSummaryMarkdown,
  health,
};

