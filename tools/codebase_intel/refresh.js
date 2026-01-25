#!/usr/bin/env node
"use strict";

/**
 * Mid-session refresh: re-inject summary only if it changed since last injection.
 *
 * Intended for UserPromptSubmit hook. Reads JSON from stdin (Claude Code payload),
 * compares summary hash to a per-session cache, emits if different.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sessionKey(data, env = process.env) {
  const raw =
    data?.session_id ||
    data?.conversation_id ||
    data?.run_id ||
    data?.terminal_id ||
    env.TMUX_PANE ||
    env.SSH_TTY ||
    "default";

  return String(raw)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

function readStdinJson(stdin = process.stdin) {
  return new Promise((resolve) => {
    let input = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (input += c));
    stdin.on("end", () => {
      try {
        resolve(input ? JSON.parse(input) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function runRefresh({
  root = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  data,
} = {}) {
  const payload = data ?? (await readStdinJson(stdin));

  const summaryPath = path.join(root, ".planning", "intel", "summary.md");
  if (!fs.existsSync(summaryPath)) return { emitted: false };

  const summary = fs.readFileSync(summaryPath, "utf8").trim();
  if (!summary) return { emitted: false };

  const key = sessionKey(payload, env);
  const cachePath = path.join(
    root,
    ".planning",
    "intel",
    `.last_injected_hash.${key}`
  );

  const h = crypto.createHash("sha256").update(summary).digest("hex");
  const last = fs.existsSync(cachePath)
    ? fs.readFileSync(cachePath, "utf8").trim()
    : "";

  // Only inject if changed since last injection for this session
  if (last === h) return { emitted: false, sessionKey: key };

  fs.writeFileSync(cachePath, h);
  stdout.write(`<codebase-intelligence>\n${summary}\n</codebase-intelligence>`);
  return { emitted: true, sessionKey: key };
}

module.exports = { runRefresh, sessionKey };

if (require.main === module) {
  runRefresh().catch(() => {});
}
