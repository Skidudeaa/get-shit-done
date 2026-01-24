# Changelog

## [Unreleased]

### Added
- Pluggable extractor architecture for multi-language support
  - `lib/extractors/` directory with language-specific modules
  - `lib/extractors/index.js` registry for extension-to-extractor mapping
  - `lib/extractors/javascript.js` - JS/TS extractor (ESM, CJS, dynamic imports, TS types)
- New extractor API functions:
  - `extractImportsFromFile(code, filePath)` - auto-detect language from path
  - `extractExportsFromFile(code, filePath)` - auto-detect language from path
  - `isSupported(ext)` - check if extension has an extractor
  - `listSupportedExtensions()` - list all registered extensions

### Changed
- Refactored `lib/extractor.js` from monolithic JS/TS-only implementation to dispatcher pattern
- Backward compatible: `extractImports(code, fileType)` and `extractExports(code, fileType)` unchanged

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
