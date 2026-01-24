# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI (bin/intel.js)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Core (lib/intel.js)                      │
│  - File discovery (fast-glob)                               │
│  - Orchestration of scan/rescan/update                      │
│  - State management per root                                │
└─────────────────────────────────────────────────────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│ Extractor │  │ Resolver  │  │   Graph   │  │  Summary  │
│ Dispatch  │  │           │  │  (SQLite) │  │ Generator │
└───────────┘  └───────────┘  └───────────┘  └───────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                Language Extractors (lib/extractors/)        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ javascript │  │  python    │  │    go      │  ...       │
│  │ (js/ts)    │  │  (future)  │  │  (future)  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

## Components

### CLI (`bin/intel.js`)
Entry point. Parses args, dispatches to core functions.

### Core (`lib/intel.js`)
- `init(root)` - create state dirs, seed files, configure Claude hook
- `scan(roots)` - index all files matching globs
- `rescan(roots)` - scan + prune deleted files
- `updateFile(root, relPath)` - incremental single-file update
- `generateSummary(root)` - write summary.md from current state

### Extractor (`lib/extractor.js`)
Dispatcher that routes to language-specific extractors.

**Public API:**
- `extractImports(code, fileType)` - extract import specifiers
- `extractExports(code, fileType)` - extract export declarations
- `extractImportsFromFile(code, filePath)` - auto-detect from path
- `extractExportsFromFile(code, filePath)` - auto-detect from path
- `isSupported(ext)` - check if language supported
- `listSupportedExtensions()` - get all extensions

### Extractors Registry (`lib/extractors/index.js`)
Maps file extensions to extractor modules.

**Adding a language:**
1. Create `lib/extractors/<language>.js` with:
   - `extensions: string[]`
   - `extractImports(code, filePath): ImportSpec[]`
   - `extractExports(code, filePath): ExportSpec[]`
2. Register in `lib/extractors/index.js`

### Resolver (`lib/resolver.js`)
Resolves import specifiers to repo-relative file paths.

**Handles:**
- Relative imports (`./foo`, `../bar`)
- Absolute imports (`/src/foo`)
- tsconfig paths (`@/components/Button`)
- Workspace packages (monorepo)
- External packages (returns null)
- Asset imports (CSS, images)

### Graph (`lib/graph.js`)
SQLite database wrapper for dependency graph.

**Tables:**
- `files` - indexed files with metadata
- `imports` - file → resolved import edges
- `exports` - file → export declarations
- `meta` - key/value store for scan state

### Summary (`lib/summary.js`)
Generates `summary.md` from graph state for Claude injection.

### Watch (`watch.js`)
File watcher using chokidar. Triggers incremental updates.

### Hook (`hooks/sessionstart.js`)
Claude Code SessionStart hook. Outputs `<codebase-intelligence>` block.

## State Layout

Per-repo state lives in `.planning/intel/`:

```
.planning/intel/
  graph.db      # SQLite: files, imports, exports, meta
  index.json    # Per-file: type, size, mtime, imports[], exports[]
  summary.md    # Human-readable summary for Claude
```

## Data Flow

### Scan
```
files (glob) → read → extract(imports, exports) → resolve(imports) → store(graph, index)
```

### Update (single file)
```
file → read → extract → resolve → update(graph, index) → regenerate(summary)
```

### Query
```
query(file) → graph.db → imports/exports/dependents
```

## Extension Points

| Component | How to Extend |
|-----------|---------------|
| Languages | Add extractor in `lib/extractors/` |
| Resolution | Add resolver in `lib/resolvers/` (future) |
| Summary format | Modify `lib/summary.js` |
| Storage | Swap graph.js implementation |
