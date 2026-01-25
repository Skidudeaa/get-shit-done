# codebase-intel

**Health-aware codebase intelligence for LLMs.**

`codebase-intel` continuously maps a repository's structure and injects a small,
factual summary into Claude Code so the model starts every session oriented,
not guessing.

It is designed to prevent the most common LLM failure mode:
**hallucinating structure due to missing or stale context.**

---

## What it does

- Indexes JavaScript, TypeScript, and Python codebases
- Builds a dependency graph from real imports
- Computes health metrics (resolution %, index age, unresolved patterns)
- Identifies hotspots and likely entry points
- Injects a concise summary into Claude Code:
  - at session start
  - live during the session when changes occur
- Provides ranked search with structural context

---

## Why it exists

LLMs are powerful but brittle when they lack orientation.
Traditional tools (search, grep, embeddings) help *after* confusion starts.

`codebase-intel` fixes the problem **before the first prompt** and keeps context fresh while you work.

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
| `scan` | Full index / repair drift |
| `watch` | Live updates (required for refresh) |
| `health` | Show resolution %, index age |
| `summary` | Print injected summary |
| `retrieve <query>` | Ranked search with graph context |

---

## Supported languages

- JavaScript
- TypeScript
- Python (AST-based parsing)

---

## Status

**v0.1.0** — Experimental but stable

Designed for real use across multiple repositories.
