# codebase-intel

Automatic codebase intelligence for LLMs. Extracts import graphs, surfaces health metrics, and injects context at session start.

**Languages:** JavaScript, TypeScript, Python

## Install

```bash
cd /path/to/this/repo
npm install && npm link
```

## Usage

```bash
cd /path/to/your/project
codebase-intel init      # creates .planning/intel/ and wires Claude hooks
codebase-intel scan      # index files (or: scan "**/*.py" "**/*.ts")
codebase-intel watch     # live updates (run in background)
```

That's it. Claude Code now receives codebase intelligence at session start and on each prompt (when changed).

## Commands

| Command | What it does |
|---------|--------------|
| `init` | Create state dir, wire Claude hooks |
| `scan` | Index files, build import graph |
| `watch` | Watch for changes, update summary |
| `health` | Show resolution %, index age, misses |
| `summary` | Print current summary |
| `retrieve <query>` | Ranked search with graph context |

## How it works

1. **Scans** your codebase for imports/exports (AST for Python, regex for JS/TS)
2. **Resolves** local imports to actual files
3. **Generates** a summary with health metrics, hotspots, entry points
4. **Injects** into Claude Code at session start
5. **Refreshes** mid-session when files change (requires `watch` running)

## Config (optional)

Create `.codebase-intel.json` in your repo:

```json
{
  "globs": ["src/**/*.ts", "**/*.py"],
  "ignore": ["**/node_modules/**", "**/dist/**"]
}
```

## State

All state lives in `.planning/intel/`:
- `graph.db` — SQLite import graph
- `index.json` — file metadata
- `summary.md` — injected into Claude

Add `.planning/` to your `.gitignore`.

## Troubleshooting

```bash
codebase-intel health    # check resolution %, index age
codebase-intel summary   # see what Claude receives
```
