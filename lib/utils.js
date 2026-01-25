const path = require("path");

function posixify(p) {
  return String(p).replace(/\\/g, "/");
}

function normalizeRelPath(relPath) {
  return posixify(String(relPath)).replace(/^\/+/, "");
}

function generateSlug(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fileTypeHeuristic(relPath) {
  const p = normalizeRelPath(relPath);
  const ext = path.extname(p).toLowerCase();

  switch (ext) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".mjs":
      return "mjs";
    case ".cjs":
      return "cjs";
    case ".json":
      return "json";
    case ".py":
      return "py";
    case ".md":
      return "md";
    default:
      return "other";
  }
}

function isIndexable(relPath) {
  const p = normalizeRelPath(relPath);
  if (!p || p.startsWith(".")) return false;

  // Hard guardrails (even if caller forgets ignore globs).
  if (
    p.includes("/node_modules/") ||
    p.includes("/.git/") ||
    p.includes("/.planning/") ||
    p.includes("/dist/") ||
    p.includes("/build/") ||
    p.includes("/.next/")
  ) {
    return false;
  }

  const t = fileTypeHeuristic(p);
  return (
    t === "ts" ||
    t === "tsx" ||
    t === "js" ||
    t === "jsx" ||
    t === "mjs" ||
    t === "cjs" ||
    t === "py"
  );
}

module.exports = {
  posixify,
  normalizeRelPath,
  generateSlug,
  isIndexable,
  fileTypeHeuristic,
};

