# TODO

## High Priority

- [ ] **Add Python extractor** - `import`, `from ... import`, `__all__`
- [ ] **Add Go extractor** - `import`, capitalized exports
- [ ] **Circular dependency detection** - surface cycles in summary
- [ ] **Barrel flattening** - trace re-exports to actual source

## Medium Priority

- [ ] **Named import tracking** - know which exports are consumed, not just file edges
- [ ] **Dead export detection** - exports never imported anywhere
- [ ] **package.json `exports` field** - modern conditional exports
- [ ] **Subpath imports** (`#internal`) - Node 16+ feature
- [ ] **Python resolver** - `sys.path`, `PYTHONPATH`, relative imports
- [ ] **Go resolver** - `go.mod` module path

## Low Priority

- [ ] **AST parsing (swc/oxc)** - replace JS regex for accuracy
- [ ] **tree-sitter integration** - unified multi-language AST
- [ ] **Rust extractor** - `use`, `mod`, `pub` exports
- [ ] **JSDoc type imports** - `@typedef {import('./x').Foo}`
- [ ] **Source map awareness** - link .js back to .ts

## Tech Debt

- [ ] **Tests** - unit tests for extractors, resolvers
- [ ] **CI/CD** - GitHub Actions for lint/test
- [ ] **npm publish** - make installable without git clone
- [ ] **Initial git commit** - track all current code

## Completed

- [x] Pluggable extractor architecture (2026-01-23)
- [x] JavaScript/TypeScript extractor
- [x] tsconfig paths resolution
- [x] Workspace package resolution
- [x] Multi-root support
- [x] Claude Code hook integration
- [x] systemd service templates
