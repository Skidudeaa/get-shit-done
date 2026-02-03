// ARCHITECTURE: Lightweight search improvements without vector embeddings.
// WHY: Structural reranking (fan-in/fan-out) already handles importance; these
//      additions improve lexical matching quality for symbol/pattern queries.
// TRADEOFF: Slightly more processing per query vs significantly better relevance.

// Common programming term synonyms for query expansion
const QUERY_SYNONYMS = {
  auth: ["auth", "authenticate", "authentication", "login", "signin", "sign-in"],
  login: ["login", "signin", "sign-in", "authenticate", "auth"],
  logout: ["logout", "signout", "sign-out", "logoff"],
  user: ["user", "account", "profile"],
  config: ["config", "configuration", "settings", "options", "prefs", "preferences"],
  error: ["error", "err", "exception", "failure", "fail"],
  request: ["request", "req", "http"],
  response: ["response", "res", "reply"],
  database: ["database", "db", "datastore", "store"],
  cache: ["cache", "memoize", "memo"],
  test: ["test", "spec", "describe", "it"],
  handler: ["handler", "controller", "middleware"],
  route: ["route", "router", "endpoint", "path"],
  api: ["api", "endpoint", "service"],
  fetch: ["fetch", "get", "request", "http"],
  create: ["create", "add", "insert", "new", "make"],
  update: ["update", "edit", "modify", "patch", "put"],
  delete: ["delete", "remove", "destroy", "drop"],
  find: ["find", "search", "query", "lookup", "get"],
  validate: ["validate", "check", "verify", "assert"],
  parse: ["parse", "decode", "deserialize"],
  serialize: ["serialize", "encode", "stringify"],
  render: ["render", "display", "show", "draw"],
  component: ["component", "widget", "element"],
  hook: ["hook", "use", "effect"],
  state: ["state", "store", "context"],
  async: ["async", "await", "promise", "then"],
  callback: ["callback", "cb", "handler", "listener"],
  event: ["event", "emit", "on", "listener"],
  util: ["util", "utils", "helper", "helpers", "lib"],
  init: ["init", "initialize", "setup", "bootstrap"],
};

// Very common keywords that add noise to matches (multi-language)
const COMMON_NOISE_WORDS = new Set([
  // JavaScript/TypeScript
  "const",
  "let",
  "var",
  "function",
  "class",
  "return",
  "import",
  "export",
  "from",
  "require",
  "module",
  "exports",
  "default",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "typeof",
  "instanceof",
  "async",
  "await",
  "yield",
  "static",
  "public",
  "private",
  "protected",
  "readonly",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "abstract",
  // Python-specific
  "def",
  "self",
  "cls",
  "None",
  "and",
  "or",
  "not",
  "in",
  "is",
  "as",
  "with",
  "pass",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "raise",
  "except",
  "elif",
  "yield",
  "from",
  "print",
  "len",
  "str",
  "int",
  "float",
  "bool",
  "list",
  "dict",
  "set",
  "tuple",
  "range",
  "super",
  "property",
  "staticmethod",
  "classmethod",
  "isinstance",
  "hasattr",
  "getattr",
  "setattr",
]);

// Symbol definition patterns by language - Python prioritized
const SYMBOL_DEF_PATTERNS = [
  // Python function definitions (sync and async)
  /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
  // Python class definitions
  /^\s*class\s+(\w+)(?:\s*\(|\s*:)/,
  // Python decorated definitions (capture the def/class after decorator)
  /^\s*@\w+.*\n\s*(?:async\s+)?def\s+(\w+)/,
  // Python variable assignment at module level (CONSTANT or regular)
  /^([A-Z][A-Z0-9_]+)\s*=/,
  /^(\w+)\s*:\s*\w+\s*=/,
  // JS/TS function definitions
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  // JS/TS arrow function assignments
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/,
  // JS/TS class definitions
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  // JS/TS method definitions (inside class)
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
  // TS interface/type definitions
  /^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/,
  // Go function/type
  /^func\s+(?:\([^)]+\)\s+)?(\w+)/,
  /^type\s+(\w+)/,
  // Rust function/struct/enum
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  /^\s*(?:pub\s+)?struct\s+(\w+)/,
  /^\s*(?:pub\s+)?enum\s+(\w+)/,
];

// Extract symbol name from a line if it's a definition
function extractSymbolDef(line) {
  if (typeof line !== "string") return null;
  for (const pattern of SYMBOL_DEF_PATTERNS) {
    const m = line.match(pattern);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Check if query term matches symbol name exactly
function isExactSymbolMatch(line, queryTerms) {
  const sym = extractSymbolDef(line);
  if (!sym) return false;
  const symLower = sym.toLowerCase();
  return queryTerms.some((t) => t.toLowerCase() === symLower);
}

// Count how many noise words dominate the line
function noiseWordRatio(line) {
  if (typeof line !== "string") return 0;
  const words = line
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  const noiseCount = words.filter((w) => COMMON_NOISE_WORDS.has(w.toLowerCase())).length;
  return noiseCount / words.length;
}

// Check if line is primarily an export statement with the query term
function isExportStatement(line, queryTerms) {
  if (typeof line !== "string") return false;

  // JS/TS export
  if (/^\s*export\s+/.test(line)) {
    const lineLower = line.toLowerCase();
    return queryTerms.some((t) => lineLower.includes(t.toLowerCase()));
  }

  // Python __all__ definition (public API declaration)
  if (/^\s*__all__\s*=/.test(line)) {
    const lineLower = line.toLowerCase();
    return queryTerms.some((t) => lineLower.includes(t.toLowerCase()));
  }

  return false;
}

// Check if this is a Python public function/class (not prefixed with _)
function isPythonPublicSymbol(line) {
  if (typeof line !== "string") return false;
  // Python def/class that doesn't start with underscore = public
  const match = line.match(/^\s*(?:async\s+)?(?:def|class)\s+(\w+)/);
  if (match && match[1] && !match[1].startsWith("_")) {
    return true;
  }
  return false;
}

// Expand a query term to include synonyms
function expandQueryTerm(term) {
  const lower = term.toLowerCase();
  const synonyms = QUERY_SYNONYMS[lower];
  if (synonyms) {
    return [...new Set([term, ...synonyms])];
  }
  return [term];
}

// Expand entire query string
function expandQuery(q) {
  if (!q || typeof q !== "string") return { original: q, expanded: q, terms: [] };

  // Split into words, preserving original for display
  const terms = q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, ""));

  const allExpanded = new Set();
  const termExpansions = [];

  for (const term of terms) {
    const expanded = expandQueryTerm(term);
    termExpansions.push({ original: term, expanded });
    for (const e of expanded) allExpanded.add(e);
  }

  // Build OR query for Zoekt/rg
  // For Zoekt: use regex alternation
  // For rg: we'll need multiple searches or regex
  const expandedTerms = [...allExpanded];

  return {
    original: q,
    expanded: expandedTerms.length > 1 ? `(${expandedTerms.join("|")})` : q,
    terms: expandedTerms,
    termExpansions,
  };
}

// Compute additional scoring signals for a hit
function computeEnhancedSignals(hit, queryTerms, opts = {}) {
  const explain = !!opts.explainHits;
  const signals = [];
  let adjustment = 0;
  const base = Number.isFinite(hit.score) ? hit.score : 1;

  const line = hit.line || "";
  const filePath = hit.path || "";
  const isPython = filePath.endsWith(".py");

  // Signal 1: Exact symbol match (strong boost)
  if (isExactSymbolMatch(line, queryTerms)) {
    adjustment += base * 0.25;
    if (explain) signals.push("exact_symbol:+25%");
  }

  // Signal 2: Export statement with query term (moderate boost)
  if (isExportStatement(line, queryTerms)) {
    adjustment += base * 0.1;
    if (explain) signals.push("export_match:+10%");
  }

  // Signal 3: High noise ratio penalty
  const noise = noiseWordRatio(line);
  if (noise > 0.7) {
    adjustment -= base * 0.15;
    if (explain) signals.push(`noise_ratio:${Math.round(noise * 100)}%:-15%`);
  } else if (noise > 0.5) {
    adjustment -= base * 0.08;
    if (explain) signals.push(`noise_ratio:${Math.round(noise * 100)}%:-8%`);
  }

  // Signal 4: Symbol definition line bonus
  const symName = extractSymbolDef(line);
  if (symName) {
    // Check if query appears in symbol name (partial match)
    const symLower = symName.toLowerCase();
    if (queryTerms.some((t) => symLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.12;
      if (explain) signals.push("symbol_contains_query:+12%");
    }
  }

  // Signal 5: Python public symbol boost (not prefixed with _)
  if (isPython && isPythonPublicSymbol(line)) {
    const lineLower = line.toLowerCase();
    if (queryTerms.some((t) => lineLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.08;
      if (explain) signals.push("python_public:+8%");
    }
  }

  // Signal 6: Docstring/comment containing query (documentation match)
  if (isPython && /^\s*("""|'''|#)/.test(line)) {
    const lineLower = line.toLowerCase();
    if (queryTerms.some((t) => lineLower.includes(t.toLowerCase()))) {
      adjustment += base * 0.05;
      if (explain) signals.push("docstring_match:+5%");
    }
  }

  return explain ? { adjustment, signals } : { adjustment };
}

module.exports = {
  QUERY_SYNONYMS,
  COMMON_NOISE_WORDS,
  expandQuery,
  expandQueryTerm,
  extractSymbolDef,
  isExactSymbolMatch,
  isExportStatement,
  isPythonPublicSymbol,
  noiseWordRatio,
  computeEnhancedSignals,
};
