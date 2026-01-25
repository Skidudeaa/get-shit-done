const { spawn, spawnSync } = require("child_process");

function which(bin) {
  const r = spawnSync("sh", ["-lc", `command -v ${bin} 2>/dev/null`], { encoding: "utf8" });
  if (r.status === 0) {
    const out = (r.stdout || "").trim();
    return out ? out : null;
  }
  return null;
}

function isInstalled() {
  return !!which("rg");
}

function readFileLines(p) {
  const fs = require("fs");
  try {
    const txt = fs.readFileSync(p, "utf8");
    return txt.split(/\r?\n/);
  } catch {
    return null;
  }
}

function addContextToHits(root, hits, contextLines) {
  if (!contextLines || contextLines <= 0) {
    for (const h of hits) {
      h.before = [];
      h.after = [];
    }
    return hits;
  }

  const path = require("path");
  const byFile = new Map();
  for (const h of hits) {
    if (!h.path) continue;
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }

  for (const [rel, fileHits] of byFile.entries()) {
    const abs = path.join(root, rel);
    const lines = readFileLines(abs);
    if (!lines) {
      for (const h of fileHits) {
        h.before = [];
        h.after = [];
      }
      continue;
    }

    for (const h of fileHits) {
      const idx = (h.lineNumber || 1) - 1;
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length - 1, idx + contextLines);

      h.before = lines.slice(start, idx);
      h.after = lines.slice(idx + 1, end + 1);
    }
  }

  return hits;
}

async function search(root, q, opts = {}) {
  if (!isInstalled()) throw new Error("rg not found in PATH");

  const mode = opts.mode || "literal";
  const maxHits = opts.maxHits ?? 50;
  const contextLines = opts.contextLines ?? 1;

  const args = ["--json", "-n", "--smart-case"];
  args.push("--glob", "!.planning/**");
  args.push("--glob", "!node_modules/**");
  args.push("--glob", "!.git/**");
  args.push("--glob", "!dist/**");
  args.push("--glob", "!build/**");
  args.push("--glob", "!.next/**");

  if (mode === "literal") args.push("-F");

  args.push(q);
  args.push(".");

  const hits = [];

  await new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: root });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === "match") {
          const data = evt.data;
          const pathText = data.path?.text;
          const ln = data.line_number;
          const text = data.lines?.text?.replace(/\n$/, "") ?? "";
          const subs = (data.submatches || []).map((sm) => ({
            start: sm.start,
            end: sm.end,
          }));

          hits.push({
            path: pathText,
            lineNumber: ln,
            line: text,
            ranges: subs,
            provider: "rg",
            score: null,
          });

          if (hits.length >= maxHits) {
            child.kill("SIGTERM");
            break;
          }
        }
      }
    });

    child.on("error", reject);
    child.on("exit", () => resolve());
  });

  addContextToHits(root, hits, contextLines);

  return {
    provider: "rg",
    stats: { matchCount: hits.length },
    hits,
  };
}

module.exports = { isInstalled, search };
