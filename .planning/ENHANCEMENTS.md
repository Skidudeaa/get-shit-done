# Codebase Enhancements & Optimizations

Comprehensive analysis performed 2026-01-26.

---

## Critical Issues

### 1. Silent Exception Swallowing

**Locations**: `lib/intel.js:87-89`, `lib/intel.js:369-378`

**Problem**: Empty catch blocks treat all errors identically. A permission error (`EACCES`) is handled the same as a deleted file (`ENOENT`), making debugging impossible.

```javascript
// Current (bad)
} catch {
  // fall through
}

// Fixed
} catch (err) {
  if (err.code === 'ENOENT') {
    // File deleted - expected, handle silently
  } else {
    console.error(`[intel] stat failed for ${abs}:`, err.message);
  }
}
```

**Impact**: Silent failures corrupt index state without any diagnostic trail.

**Effort**: Low (< 30 min)

---

### 2. Python Subprocess Per File

**Location**: `lib/extractors/python.js:46-51`

**Problem**: `spawnSync("python3", ...)` blocks the event loop and incurs ~50-100ms process spawn overhead per file. For 1000 Python files, this adds 50-100 seconds to indexing.

```javascript
// Current - synchronous, spawns per file
const r = spawnSync("python3", [SCRIPT_PATH], {
  input,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30000,
});
```

**Fix**: Implement persistent Python worker using JSON-lines protocol:

```javascript
// Worker receives files via stdin, returns results via stdout
// One subprocess handles entire batch
const worker = spawn("python3", [WORKER_PATH]);
worker.stdin.write(JSON.stringify({ path: rel, source }) + '\n');
// Read result from stdout
```

**Impact**: ~10x faster Python indexing on large codebases.

**Effort**: High (2-4 hours)

---

### 3. Duplicate Python AST Parsing

**Location**: `lib/extractors/python.js:137-152`

**Problem**: `extractImports()` and `extractExports()` each call `extractPythonAST()` independently, parsing the same file twice.

```javascript
// Both functions spawn a subprocess for the same file
function extractImports(source, _opts) {
  const { imports } = extractPythonAST(source); // subprocess #1
  return imports;
}
function extractExports(source, _opts) {
  const { exports } = extractPythonAST(source); // subprocess #2
  return exports;
}
```

**Fix**: Cache results or call once and split:

```javascript
function extractBoth(source, _opts) {
  const { imports, exports } = extractPythonAST(source);
  return { imports, exports };
}
```

**Effort**: Low (< 30 min)

---

### 4. Config Drift Between CLI and Watcher

**Locations**: `bin/intel.js:44-65` vs `watch.js:117-129`

**Problem**: Default globs differ - watcher completely omits Python files:

```javascript
// bin/intel.js (correct)
globs: [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs,py}",
  "lib/**/*.{ts,tsx,js,jsx,mjs,cjs,py}",
  "**/*.py"
],

// watch.js (missing Python!)
globs: [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "lib/**/*.{ts,tsx,js,jsx,mjs,cjs}"
],
```

**Fix**: Extract `loadRepoConfig()` to shared `lib/config.js` module.

**Effort**: Low (< 30 min)

---

## Performance Optimizations

### 5. Add Mtime-Based Cache Skipping

**Location**: `lib/intel.js:382-400`

**Problem**: Every file is re-extracted on scan, even if unchanged.

**Fix**:

```javascript
async function indexOneFileUnlocked(st, db, rel) {
  const stat = await fs.promises.stat(abs);
  const mtimeMs = Math.floor(stat.mtimeMs);
  
  // Skip if unchanged
  const cached = st.index?.files?.[rel];
  if (cached?.mtimeMs === mtimeMs) {
    return; // Already indexed, skip extraction
  }
  
  // ... proceed with extraction
}
```

**Impact**: Near-instant re-scans when files haven't changed.

**Effort**: Low (< 30 min)

---

### 6. Parallelize File Indexing

**Location**: `lib/intel.js:492-496`

**Problem**: Files are indexed sequentially in a for-loop.

```javascript
// Current - sequential
for (const rel of matches) {
  await indexOneFileUnlocked(st, db, rel);
}
```

**Fix**:

```javascript
const pLimit = require('p-limit');
const limit = pLimit(10); // 10 concurrent

await Promise.all(
  matches.map(rel => limit(() => indexOneFileUnlocked(st, db, rel)))
);
```

**Impact**: ~5-10x faster full scans on multi-core systems.

**Effort**: Medium (1 hour)

---

### 7. Cache Prepared SQL Statements

**Location**: `lib/graph.js:93-98`

**Problem**: Every database operation creates and frees a prepared statement:

```javascript
const stmt = db.prepare("INSERT OR REPLACE INTO files(...) VALUES (?,?,?,?,?)");
stmt.run([...]);
stmt.free(); // Created and destroyed every call
```

**Fix**: Use statement cache:

```javascript
const stmtCache = new WeakMap();

function getStmt(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) { cache = {}; stmtCache.set(db, cache); }
  if (!cache[sql]) cache[sql] = db.prepare(sql);
  return cache[sql];
}

// Usage
const stmt = getStmt(db, "INSERT OR REPLACE INTO files(...) VALUES (?,?,?,?,?)");
stmt.run([...]); // No free - reused
```

**Impact**: ~20-30% faster graph operations.

**Effort**: Medium (1 hour)

---

## Code Duplication

### 8. Duplicate `isEntryPoint()` Function

**Locations**: `lib/retrieve.js:6-9`, `lib/summary.js:60-63`

**Problem**: Identical regex defined in two files.

**Fix**: Move to `lib/utils.js`:

```javascript
// lib/utils.js
const ENTRY_POINT_RE = /(src\/)?(main|index|app|root|router|routes)\.(ts|tsx|js|jsx|mjs|cjs)$/i;

function isEntryPoint(relPath) {
  return ENTRY_POINT_RE.test(relPath || "");
}

module.exports = { isEntryPoint };
```

**Effort**: Low (15 min)

---

### 9. Duplicate `which()` Function

**Locations**: `lib/rg.js:4-10`, `lib/zoekt.js:34-41`

**Problem**: Identical binary lookup function.

**Fix**: Move to `lib/utils.js`.

**Effort**: Low (15 min)

---

### 10. Duplicate `getGitInfo()` Function

**Locations**: `lib/summary.js:65-79`, `lib/retrieve.js:341-355`

**Problem**: Same git info fetching logic.

**Fix**: Create `lib/git.js`:

```javascript
// lib/git.js
const { execSync } = require("child_process");

function getGitInfo(rootAbs) {
  try {
    return {
      branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: rootAbs, encoding: "utf8" }).trim(),
      head: execSync("git rev-parse HEAD", { cwd: rootAbs, encoding: "utf8" }).trim().slice(0, 12),
    };
  } catch {
    return null;
  }
}

module.exports = { getGitInfo };
```

**Effort**: Low (15 min)

---

### 11. Duplicate CLI Utilities

**Locations**: `bin/intel.js:10-82`, `watch.js:91-129`

**Problem**: `flag()`, `readRootsFile()`, `rootsFromArgs()`, `loadRepoConfig()` duplicated.

**Fix**: Create `lib/config.js` with shared logic.

**Effort**: Medium (45 min)

---

### 12. Repetitive Scheduler Pattern

**Location**: `lib/intel.js:115-223`

**Problem**: Three nearly identical scheduler functions: `scheduleIndexFlush`, `scheduleGraphPersist`, `scheduleSummary`.

**Fix**: Generic debounced scheduler factory:

```javascript
function createScheduler(state, key, action, debounceMs = 750) {
  return () => {
    state[`${key}Dirty`] = true;
    clearTimeout(state[`${key}Timer`]);
    state[`${key}Timer`] = setTimeout(async () => {
      if (state[`${key}Dirty`]) {
        state[`${key}Dirty`] = false;
        await action();
      }
    }, debounceMs);
  };
}
```

**Effort**: Low (30 min)

---

## Missing Functionality

### 13. No pnpm Workspace Support

**Location**: `lib/resolver.js:120-124`

**Problem**: Only handles `package.json` workspaces, not `pnpm-workspace.yaml`.

**Fix**:

```javascript
function loadWorkspacePackages(rootAbs) {
  // Try pnpm-workspace.yaml first
  const pnpmPath = path.join(rootAbs, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) {
    const yaml = require("js-yaml");
    const pnpm = yaml.load(fs.readFileSync(pnpmPath, "utf8"));
    if (pnpm?.packages) {
      return expandGlobs(pnpm.packages, rootAbs);
    }
  }
  // Fall back to package.json workspaces
  // ...existing logic
}
```

**Effort**: Low (30 min, add `js-yaml` dependency)

---

### 14. No Circular Dependency Detection

**Location**: `lib/graph.js`

**Problem**: Graph stores edges but doesn't expose cycle detection.

**Fix**: Add Tarjan's algorithm for SCC detection:

```javascript
function findCycles(db) {
  // Build adjacency list from imports table
  // Run Tarjan's SCC algorithm
  // Return array of cycles as file arrays
}
```

**Impact**: Valuable architecture health metric.

**Effort**: Medium (2 hours)

---

### 15. No Index Versioning/Migration

**Location**: `lib/intel.js:12`

**Problem**: `INDEX_VERSION = 1` exists but no migration logic when schema changes.

**Fix**:

```javascript
const MIGRATIONS = {
  1: (index) => { /* v0 -> v1 */ },
  2: (index) => { /* v1 -> v2 */ },
};

function migrateIndex(index) {
  while (index.version < INDEX_VERSION) {
    MIGRATIONS[index.version + 1](index);
    index.version++;
  }
  return index;
}
```

**Effort**: Low (30 min)

---

### 16. TypeScript Path Aliases - Multiple Targets

**Location**: `lib/resolver.js:203-216`

**Problem**: Only uses first matching target; tsconfig allows fallback arrays.

```json
{
  "paths": {
    "@/*": ["src/*", "generated/*"]  // Should try src first, then generated
  }
}
```

**Fix**: Loop through targets until one resolves.

**Effort**: Medium (1 hour)

---

## Memory & Resource Issues

### 17. SQLite Database Memory Leak

**Location**: `lib/graph.js:24`

**Problem**: `dbByRoot` Map grows forever; no cleanup mechanism.

**Fix**:

```javascript
function closeDb(rootAbs) {
  const db = dbByRoot.get(rootAbs);
  if (db) {
    db.close();
    dbByRoot.delete(rootAbs);
  }
}

// Call on project close or idle timeout
```

**Effort**: Low (30 min)

---

### 18. Zoekt Server Startup Race Condition

**Location**: `lib/zoekt.js:150-151`

**Problem**: Fixed 250ms sleep is fragile on slow systems.

**Fix**: Exponential backoff with probe:

```javascript
for (let delay = 100; delay <= 2000; delay *= 2) {
  await sleep(delay);
  if (await probeZoektApi(port)) return { ok: true };
}
return { ok: false, error: "Zoekt startup timeout" };
```

**Effort**: Low (30 min)

---

### 19. No Ripgrep Timeout

**Location**: `lib/rg.js:90`

**Problem**: Subprocess spawned without timeout; malformed regex could hang.

**Fix**:

```javascript
const child = spawn("rg", args, { cwd: root, timeout: 30000 });
```

**Effort**: Low (15 min)

---

## CLI/DX Improvements

### 20. Missing `--version` Command

**Location**: `bin/intel.js`

**Fix**:

```javascript
case "version":
case "--version":
case "-v":
  const pkg = require("../package.json");
  console.log(pkg.version);
  process.exit(0);
```

**Effort**: Low (10 min)

---

### 21. Missing `--verbose` / `--quiet` Flags

**Location**: `bin/intel.js`

**Fix**: Add log level control:

```javascript
const VERBOSE = hasFlag(process.argv, "--verbose") || hasFlag(process.argv, "-v");
const QUIET = hasFlag(process.argv, "--quiet") || hasFlag(process.argv, "-q");

function log(...args) {
  if (!QUIET) console.error("[intel]", ...args);
}
function debug(...args) {
  if (VERBOSE) console.error("[intel:debug]", ...args);
}
```

**Effort**: Low (30 min)

---

### 22. No Progress Indication for `scan`

**Location**: `bin/intel.js`

**Problem**: Large codebases show no progress during scan.

**Fix**:

```javascript
let processed = 0;
for (const rel of matches) {
  await indexOneFileUnlocked(st, db, rel);
  processed++;
  if (processed % 100 === 0) {
    process.stderr.write(`\r[intel] Indexed ${processed}/${matches.length} files`);
  }
}
process.stderr.write(`\r[intel] Indexed ${matches.length} files\n`);
```

**Effort**: Low (20 min)

---

### 23. No `--flag=value` Syntax Support

**Location**: `bin/intel.js:10-18`

**Problem**: Only `--flag value` works, not `--flag=value`.

**Fix**:

```javascript
function flag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      return argv[i + 1];
    }
    if (argv[i].startsWith(name + "=")) {
      return argv[i].slice(name.length + 1);
    }
  }
  return null;
}
```

**Effort**: Low (15 min)

---

## Testing Gaps

### 24. No Unit Test Framework

**Problem**: All tests are bash scripts. No framework for unit testing extractors, resolver, graph.

**Fix**:

```bash
npm install --save-dev vitest
```

Create `test/extractors.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { extractImports } from '../lib/extractors/javascript.js';

describe('JavaScript extractor', () => {
  it('extracts ESM imports', () => {
    const src = `import { foo } from './bar';`;
    expect(extractImports(src)).toContain('./bar');
  });
  
  it('ignores commented imports', () => {
    const src = `// import { foo } from './bar';`;
    expect(extractImports(src)).toEqual([]);
  });
});
```

**Priority order for tests**:
1. `lib/extractors/javascript.js` - regex patterns
2. `lib/extractors/python.js` - AST parsing
3. `lib/resolver.js` - import resolution
4. `lib/graph.js` - SQLite operations
5. `lib/summary.js` - summary generation

**Effort**: High (4+ hours for good coverage)

---

### 25. npm Test Script Discrepancy

**Location**: `package.json:5`

**Problem**: `npm test` runs `scripts/test-refresh.sh` (4 tests), not `test/test-refresh.sh` (10 tests).

**Fix**:

```json
{
  "scripts": {
    "test": "bash test/test-refresh.sh",
    "test:quick": "bash scripts/test-refresh.sh",
    "test:unit": "vitest run"
  }
}
```

**Effort**: Low (5 min)

---

## Configuration Issues

### 26. Inconsistent Hook Invocation

**Location**: `.claude/settings.json`

**Problem**: 
- `SessionStart` uses CLI: `codebase-intel hook sessionstart`
- `UserPromptSubmit` uses direct node: `node tools/codebase_intel/refresh.js`

**Risk**: Different code paths, divergent behavior over time.

**Fix**: Unify to CLI:

```json
{
  "UserPromptSubmit": [{
    "matcher": "*",
    "hooks": [{
      "type": "command",
      "command": "codebase-intel hook refresh"
    }]
  }]
}
```

Or keep direct node but consolidate `refresh.js` logic into main lib.

**Effort**: Medium (1 hour)

---

## Priority Roadmap

### Quick Wins (< 30 min each)
- [ ] Fix silent exception swallowing (#1)
- [ ] Fix Python double-parsing (#3)
- [ ] Fix config drift - Python globs (#4)
- [x] Add mtime-based cache skipping (#5) ✓ DONE
- [ ] Extract `isEntryPoint()` to utils (#8)
- [ ] Extract `which()` to utils (#9)
- [ ] Add `--version` command (#20)
- [ ] Fix npm test script (#25)

### Medium Effort (1-2 hours)
- [ ] Parallelize file indexing (#6)
- [ ] Cache prepared SQL statements (#7)
- [ ] Extract `getGitInfo()` to git.js (#10)
- [ ] Extract CLI utilities to config.js (#11)
- [ ] Create generic scheduler factory (#12)
- [ ] Add pnpm workspace support (#13)
- [ ] Add `--verbose`/`--quiet` flags (#21)
- [x] Add scan progress indication (#22) ✓ DONE

### Larger Projects (4+ hours)
- [ ] Implement Python batch worker (#2)
- [ ] Add circular dependency detection (#14)
- [ ] Add vitest + unit tests (#24)
- [ ] Unify hook invocation (#26)

---

## Language Extractor Expansion

Current support: JavaScript, TypeScript, Python

### Recommended additions:

| Language | Imports | Exports | Effort |
|----------|---------|---------|--------|
| Go | `import "pkg"`, `import (...)` | Capitalized names | Medium |
| Rust | `use crate::mod`, `mod name` | `pub fn`, `pub struct` | Medium |
| Ruby | `require`, `require_relative` | `def`, `class`, `module` | Medium |
| Java | `import com.foo.Bar` | `public class/interface` | Medium |

---

## Files Modified by These Changes

| File | Changes |
|------|---------|
| `lib/utils.js` | Add `isEntryPoint`, `which` |
| `lib/git.js` | New file - extract git utilities |
| `lib/config.js` | New file - shared CLI/config utilities |
| `lib/intel.js` | Mtime caching, parallel indexing, scheduler factory |
| `lib/graph.js` | Statement caching, `closeDb()` |
| `lib/extractors/python.js` | Cache AST results, async worker |
| `lib/resolver.js` | pnpm support, multi-target paths |
| `lib/rg.js` | Add timeout, use shared `which` |
| `lib/zoekt.js` | Exponential backoff, use shared `which` |
| `lib/retrieve.js` | Use shared `isEntryPoint`, `getGitInfo` |
| `lib/summary.js` | Use shared `isEntryPoint`, `getGitInfo` |
| `bin/intel.js` | Use shared config, add --version/--verbose |
| `watch.js` | Use shared config |
| `package.json` | Fix test script, add vitest |
