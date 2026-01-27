# codebase-intel

**Health-aware codebase intelligence for LLMs.**

`codebase-intel` is a lightweight, health-aware codebase intelligence service designed
to keep LLM coding agents oriented, honest, and up-to-date while working in real
repositories.

It continuously maps a repository's structure and injects a small, factual summary
into Claude Code so the model starts every session oriented, not guessing. It is
designed to prevent the most common LLM failure mode: **hallucinating structure due
to missing or stale context.**

---

## What it does

- Indexes real structure in JavaScript, TypeScript, and Python by extracting
  imports/exports (AST-based for Python) and building a dependency graph
- Resolves local imports deterministically (relative paths, TS path aliases,
  workspaces, Python relative/local modules) and records unresolved cases explicitly
- Tracks health metrics—import resolution %, index age, and top misses—so the
  system knows when its model of the repo is trustworthy and when it is not
- Generates a bounded, factual summary (hotspots, entry points, recent changes,
  health) stored on disk as the single source of truth
- Injects that summary into Claude Code:
  - once at SessionStart to establish orientation
  - mid-session when the summary changes (deduped per session)
- Provides structured retrieval via `retrieve`, combining search (rg or Zoekt)
  with graph-aware reranking and limited neighbor expansion

---

## Why it exists

LLM coding failures are usually orientation failures: the model starts in the
wrong files, misses blast radius, or hallucinates structure from incomplete
context. Search alone helps after confusion begins and often amplifies noise.

`codebase-intel` solves this by:
- establishing an accurate mental map before the first prompt,
- keeping that map fresh while the session is ongoing,
- and making drift visible and actionable instead of silent.

The result is not "smarter" models, but more reliable ones—agents that start in
the right place, understand impact, and know when their understanding is degraded.

---

## Installation (once per machine)

```bash
cd /path/to/codebase-intel
npm install
npm link
```

Verify:

```bash
codebase-intel --help
```

---

## Using it in a project

```bash
cd /path/to/project
./path/to/codebase-intel/scripts/setup.sh
```

Or manually:

```bash
codebase-intel init
codebase-intel scan
codebase-intel watch --summary-every 5
```

That's it.

Claude Code will now receive codebase intelligence automatically.

---

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize repo state and wire Claude hooks |
| `scan [--force]` | Full index (skips unchanged files unless forced) |
| `rescan [--force]` | Scan + prune deleted files |
| `watch` | Live updates with dashboard |
| `health [--pretty]` | Show resolution %, index age |
| `doctor` | Visual diagnostic dashboard with trends |
| `summary` | Print injected summary |
| `retrieve <query> [--pretty]` | Ranked search with graph context |

---

## Visual Features

The CLI includes rich terminal visualizations:

```
## Health
  resolution        ████████████░░░░░░░░ 62%  23/37

  Trends            (10 snapshots)
  resolution        ▁▃▄▃▅▇▆█▇▅  55% → 62%  +7%
  files             ▁▂▃▄▅▅▆▇▇█  18 → 25  +7
```

- **Progress bars** during scan/rescan
- **Sparklines** for health trends over time
- **Live dashboard** during watch mode
- **Relevance bars** in search results (`retrieve --pretty`)

---

## Supported languages

- JavaScript
- TypeScript
- Python (AST-based parsing)

---

## Status

**v0.1.0** — Experimental but stable

Designed for real use across multiple repositories.
