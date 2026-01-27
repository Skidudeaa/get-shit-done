# Changelog

## [Unreleased]

### Added
- **Terminal visualizations** (`lib/terminal-viz.js`)
  - Progress bars, sparklines, status icons, colored output
  - Zero dependencies - uses ANSI escape codes directly
- **Scan progress bar** - animated progress during `scan`/`rescan`
- **`--force` flag** for scan/rescan - bypass mtime cache, reindex all files
- **`--pretty` flag** for `health` and `retrieve` - visual output mode
- **Live watch dashboard** - real-time stats, activity sparkline, resolution bar
  - `--no-dashboard` flag for headless operation
- **Historical health tracking** (`lib/history.js`)
  - Records snapshots on each summary write
  - `doctor` shows resolution/files trends as sparklines
- **Mtime-based cache skipping** - skip unchanged files during scan (5-10x faster rescans)

### Changed
- `doctor` command now shows visual bars, colored status icons, trend sparklines
- Scan output shows indexed vs unchanged file counts

---

- Pluggable extractor architecture for multi-language support
  - `lib/extractors/` directory with language-specific modules
  - `lib/extractors/index.js` registry for extension-to-extractor mapping
  - `lib/extractors/javascript.js` - JS/TS extractor (ESM, CJS, dynamic imports, TS types)
- New extractor API functions:
  - `extractImportsFromFile(code, filePath)` - auto-detect language from path
  - `extractExportsFromFile(code, filePath)` - auto-detect language from path
  - `isSupported(ext)` - check if extension has an extractor
  - `listSupportedExtensions()` - list all registered extensions
- UserPromptSubmit refresh helper (`tools/codebase_intel/refresh.js`) with per-session dedupe

### Changed
- Refactored `lib/extractor.js` from monolithic JS/TS-only implementation to dispatcher pattern
- Backward compatible: `extractImports(code, fileType)` and `extractExports(code, fileType)` unchanged
- Refresh injection uses `<codebase-intelligence>` tag to match SessionStart

## [0.1.0] - 2026-01-23

### Added
- Initial implementation
- CLI commands: `init`, `scan`, `rescan`, `update`, `watch`, `summary`, `health`, `query`, `hook`, `inject`
- SQLite-backed dependency graph (`graph.db`)
- Per-file index with imports/exports (`index.json`)
- Human-readable summary for Claude injection (`summary.md`)
- Claude Code SessionStart hook integration
- tsconfig.json paths and baseUrl resolution
- Monorepo workspace package resolution
- Multi-root support (`--roots`, `--roots-file`)
- systemd user service templates
