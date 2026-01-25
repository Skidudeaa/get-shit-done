#!/usr/bin/env python3
"""
Parse Python source via stdlib ast and emit imports/exports in JSON.

Input: JSON on stdin:
  { "path": "relative/path.py", "content": "<file text>" }

Output JSON:
  {
    "path": "...",
    "imports": [
      {"kind":"import","module":"os","name":null,"asname":null,"level":0},
      {"kind":"from","module":"pkg.sub","name":"x","asname":"y","level":0},
      {"kind":"from","module":null,"name":"foo","asname":null,"level":1}
    ],
    "exports": {
      "functions": ["f"],
      "classes": ["C"],
      "assignments": ["CONST"],
      "all": ["a","b"]
    }
  }
"""
import ast
import json
import sys
from typing import Any, Dict, List, Optional


def _const_str(node: ast.AST) -> Optional[str]:
    """Extract string value from Constant node."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _extract_all(tree: ast.Module) -> Optional[List[str]]:
    """Extract __all__ = ["a", "b"] if it's a literal list/tuple of strings."""
    for n in tree.body:
        if not isinstance(n, ast.Assign):
            continue
        for t in n.targets:
            if isinstance(t, ast.Name) and t.id == "__all__":
                if isinstance(n.value, (ast.List, ast.Tuple)):
                    vals = []
                    for e in n.value.elts:
                        s = _const_str(e)
                        if s is None:
                            return None  # Non-literal element, can't determine
                        vals.append(s)
                    return vals
    return None


def _is_toplevel(node: ast.AST, tree: ast.Module) -> bool:
    """Check if a node is at module top-level (in tree.body)."""
    return node in tree.body


def extract(file_path: str, content: str) -> Dict[str, Any]:
    """
    Extract imports and exports from Python source.
    
    Returns empty results on syntax error rather than crashing the pipeline.
    """
    empty_result = {
        "path": file_path,
        "imports": [],
        "exports": {
            "functions": [],
            "classes": [],
            "assignments": [],
            "all": None,
        },
    }

    try:
        tree = ast.parse(content, filename=file_path)
    except SyntaxError:
        return empty_result

    imports: List[Dict[str, Any]] = []
    funcs: List[str] = []
    classes: List[str] = []
    assigns: List[str] = []

    # Walk entire tree for imports (can appear anywhere)
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                imports.append({
                    "kind": "import",
                    "module": a.name,
                    "name": None,
                    "asname": a.asname,
                    "level": 0,
                })
        elif isinstance(n, ast.ImportFrom):
            for a in n.names:
                imports.append({
                    "kind": "from",
                    "module": n.module,
                    "name": a.name,
                    "asname": a.asname,
                    "level": n.level or 0,
                })

    # Only collect top-level definitions as exports
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not n.name.startswith("_"):
                funcs.append(n.name)
        elif isinstance(n, ast.ClassDef):
            if not n.name.startswith("_"):
                classes.append(n.name)
        elif isinstance(n, ast.Assign):
            # Top-level ALLCAPS assignments (constants)
            for t in n.targets:
                if isinstance(t, ast.Name):
                    name = t.id
                    # Include if ALLCAPS or in __all__
                    if name.isupper() or (name and not name.startswith("_")):
                        if name.isupper():
                            assigns.append(name)

    return {
        "path": file_path,
        "imports": imports,
        "exports": {
            "functions": sorted(set(funcs)),
            "classes": sorted(set(classes)),
            "assignments": sorted(set(assigns)),
            "all": _extract_all(tree),
        },
    }


def main() -> None:
    """Read JSON from stdin, extract, write JSON to stdout."""
    data = json.load(sys.stdin)
    out = extract(data.get("path", ""), data.get("content", ""))
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
